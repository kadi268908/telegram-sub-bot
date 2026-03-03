// src/bot/handlers.js
// User-facing bot handlers:
//   /start  - welcome + referral processing
//   /status - subscription panel with renewal buttons
//   /support - Topics-based live support chat (1 per day)
//   /cancel  - user closes their own support chat
//   request_access, renew_request, view_offers, my_referral

const { Markup } = require('telegraf');
const fs = require('fs');
const path = require('path');
const User = require('../models/User');
const Request = require('../models/Request');
const Subscription = require('../models/Subscription');
const Plan = require('../models/Plan');
const UserOffer = require('../models/UserOffer');

const { findOrCreateUser } = require('../services/userService');
const { getActiveOffers, getActivePlans } = require('../services/adminService');
const {
  openTicket,
  forwardUserMessage,
  closeTicket,
  getActiveTicket,
  SUPPORT_CONTACT,
} = require('../services/supportService');
const {
  processReferral,
  processSellerReferral,
  registerSellerProgram,
  getSellerProgramSummary,
  requestSellerWithdrawal,
} = require('../services/referralService');
const { safeSend, renewalKeyboard, isGroupMember } = require('../utils/telegramUtils');
const { formatDate, daysRemaining } = require('../utils/dateUtils');
const { getGroupIdForCategory } = require('../utils/premiumGroups');
const logger = require('../utils/logger');

const REJOINING_PENALTY = process.env.REJOINING_PENALTY || '20';
const lastBotMessageByChat = new Map();

const PLAN_CATEGORY = {
  MOVIE: 'movie',
  DESI: 'desi',
  NON_DESI: 'non_desi',
  GENERAL: 'general',
};

const PLAN_CATEGORY_LABELS = {
  [PLAN_CATEGORY.MOVIE]: 'Movie Premium',
  [PLAN_CATEGORY.DESI]: 'Desi Premium',
  [PLAN_CATEGORY.NON_DESI]: 'Non Desi Premium',
  [PLAN_CATEGORY.GENERAL]: 'General Premium',
};

const PLAN_CATEGORY_BUTTON_LABELS = {
  [PLAN_CATEGORY.MOVIE]: 'Movie Plan',
  [PLAN_CATEGORY.DESI]: 'Desi Po*n Plan',
  [PLAN_CATEGORY.NON_DESI]: 'Non-Desi Po*n Plan',
};

const QR_ASSET_BY_CATEGORY = {
  [PLAN_CATEGORY.MOVIE]: 'qr-code.jpg',
  [PLAN_CATEGORY.DESI]: 'qr-code.jpg',
  [PLAN_CATEGORY.NON_DESI]: 'qr-code.jpg',
};

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Button coloring (Bot API 9.4+). Older clients ignore `style`.
 * Styles: 'primary' (blue), 'success' (green), 'danger' (red)
 */
const withStyle = (button, style) => ({ ...button, style });

const escapeMarkdown = (value) => {
  return String(value ?? '').replace(/([_*`\[])/g, '\\$1');
};

const normalizePlanCategory = (value) => {
  const normalized = String(value || PLAN_CATEGORY.GENERAL).toLowerCase().replace(/[-\s]/g, '_');
  if ([PLAN_CATEGORY.MOVIE, PLAN_CATEGORY.DESI, PLAN_CATEGORY.NON_DESI, PLAN_CATEGORY.GENERAL].includes(normalized)) {
    return normalized;
  }
  return PLAN_CATEGORY.GENERAL;
};

const getPlanCategoryLabel = (category) => {
  return PLAN_CATEGORY_LABELS[normalizePlanCategory(category)] || PLAN_CATEGORY_LABELS[PLAN_CATEGORY.GENERAL];
};

const formatInr = (value) => {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return '0';
  const rounded = Math.round(number * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2);
};

const getBestPublicOffer = async () => {
  const offers = await getActiveOffers();
  if (!offers?.length) return null;

  const validOffers = offers
    .filter((offer) => Number(offer.discountPercent) > 0)
    .sort((left, right) => Number(right.discountPercent || 0) - Number(left.discountPercent || 0));

  return validOffers[0] || null;
};

const getDiscountedPrice = (price, discountPercent) => {
  const base = Number(price || 0);
  const discount = Number(discountPercent || 0);
  if (!base || discount <= 0) return base;
  return Math.ceil(Math.max(0, base - (base * discount / 100)));
};

const strikeText = (value) => {
  return String(value || '').split('').map((ch) => `${ch}\u0336`).join('');
};

const isMessageNotModifiedError = (err) => {
  const message = err?.response?.description || err?.description || err?.message || '';
  return String(message).toLowerCase().includes('message is not modified');
};

const safeEditMessage = async (ctx, text, extra = {}) => {
  try {
    await ctx.editMessageText(text, extra);
  } catch (err) {
    if (isMessageNotModifiedError(err)) return;

    const message = String(err?.response?.description || err?.description || err?.message || '').toLowerCase();
    const needsCaptionEdit =
      message.includes('there is no text in the message to edit') ||
      message.includes('message text is empty');

    if (!needsCaptionEdit) throw err;

    try {
      await ctx.editMessageCaption(text, extra);
    } catch (captionErr) {
      if (!isMessageNotModifiedError(captionErr)) throw captionErr;
    }
  }
};

const sellerProgramKeyboard = (isRegistered, canWithdraw = false) => {
  const rows = [
    [withStyle(Markup.button.callback(isRegistered ? '📊 Refresh Seller Dashboard' : '🛍 Register as Seller', isRegistered ? 'seller_program' : 'register_seller'), 'primary')],
  ];

  if (isRegistered) {
    rows.push([withStyle(Markup.button.callback('💸 Request Withdrawal', 'seller_withdraw'), canWithdraw ? 'success' : 'primary')]);
  }

  rows.push([withStyle(Markup.button.callback('⬅️ Back', 'more_menu'), 'success')]);
  return Markup.inlineKeyboard(rows);
};

const formatSellerProgramMessage = (summary, botUsername) => {
  if (!summary?.isSeller) {
    return (
      `🛍 *Seller Program*\n\n` +
      `Seller banke aap premium refer karke earning kar sakte hain.\n` +
      `Har successful paid referral par *15% commission* milega.\n\n` +
      `Withdrawal eligibility:\n` +
      `• ${summary?.withdrawRules?.minReferrals || 10} qualified referrals *ya*\n` +
      `• ₹${summary?.withdrawRules?.minBalance || 200} balance\n\n` +
      `Niche button dabakar seller program join karein.`
    );
  }

  const sellerLink = `https://t.me/${botUsername}?start=seller_${summary.sellerCode}`;
  return (
    `🛍 *Seller Dashboard*\n\n` +
    `✅ Status: *Registered Seller*\n` +
    `🧾 Seller Code: \`${summary.sellerCode}\`\n` +
    `👥 Total Referred: *${summary.stats.totalReferrals || 0}*\n` +
    `✅ Qualified Referrals: *${summary.stats.qualifiedReferrals || 0}*\n` +
    `💰 Lifetime Earnings: *₹${Number(summary.stats.lifetimeEarnings || 0).toFixed(2)}*\n` +
    `💳 Available Balance: *₹${Number(summary.stats.availableBalance || 0).toFixed(2)}*\n\n` +
    `🔗 *Your Seller Link:*\n\`${sellerLink}\`\n\n` +
    (summary.canWithdraw
      ? `✅ You are eligible to request withdrawal.`
      : `ℹ️ Withdrawal unlock: ${summary.withdrawRules.minReferrals} qualified referrals *or* ₹${summary.withdrawRules.minBalance} balance.`)
  );
};

const supportCancelKeyboard = () => Markup.inlineKeyboard([
  [withStyle(Markup.button.callback('❌ Cancel Support Chat', 'cancel_support'), 'danger')],
]);

const replacePreviousBotReply = async (ctx, chatId, sentMessage) => {
  if (!sentMessage?.message_id) return;

  const key = String(chatId);
  const previousMessageId = lastBotMessageByChat.get(key);

  if (previousMessageId && previousMessageId !== sentMessage.message_id) {
    await ctx.telegram.deleteMessage(chatId, previousMessageId).catch(() => { });
  }

  lastBotMessageByChat.set(key, sentMessage.message_id);
};

const notifySellerWithdrawalRequest = async (bot, ctx, request) => {
  if (!process.env.LOG_CHANNEL_ID) return;

  const sellerName = ctx.from?.first_name || 'Seller';
  const sellerUsername = ctx.from?.username ? `@${ctx.from.username}` : 'N/A';

  await bot.telegram.sendMessage(
    process.env.LOG_CHANNEL_ID,
    `💸 *New Seller Withdrawal Request*\n\n` +
    `Request ID: \`${request._id}\`\n` +
    `Seller: *${sellerName}*\n` +
    `Seller ID: \`${request.sellerTelegramId}\`\n` +
    `Username: ${sellerUsername}\n` +
    `Amount: *₹${Number(request.amount).toFixed(2)}*\n` +
    `Requested At: ${new Date(request.requestedAt).toLocaleString('en-IN')}`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Approve', callback_data: `swd_approve_${request._id}` },
          { text: '❌ Reject', callback_data: `swd_reject_${request._id}` },
        ]],
      },
    }
  ).catch(() => { });
};

const consumeOneTimeUserOffer = async (telegramId, requestId) => {
  return UserOffer.findOneAndUpdate(
    {
      targetTelegramId: telegramId,
      isActive: true,
      isUsed: false,
      validTill: { $gt: new Date() },
    },
    {
      $set: {
        isUsed: true,
        usedAt: new Date(),
        usedByRequestId: requestId,
      },
    },
    {
      sort: { createdAt: 1 },
      new: true,
    }
  );
};

/**
 * Build the approval keyboard for log channel requests.
 * Uses real plans from DB if any exist; falls back to hardcoded day options.
 */
const buildApprovalKeyboard = async (requestId, requestCategory = PLAN_CATEGORY.GENERAL) => {
  const normalizedCategory = normalizePlanCategory(requestCategory);
  const plans = await Plan.find({ isActive: true, category: normalizedCategory }).sort({ durationDays: 1 });

  let planButtons;
  if (plans.length > 0) {
    const rows = [];
    for (let i = 0; i < plans.length; i += 2) {
      rows.push(
        plans.slice(i, i + 2).map(p => withStyle({
          text: `${p.name} (${p.durationDays}d${p.price ? ` · ₹${p.price}` : ''})`,
          callback_data: `approve_${requestId}_${p._id}`,
        }, 'success'))
      );
    }
    planButtons = rows;
  } else {
    planButtons = [];
  }

  return {
    inline_keyboard: [
      ...planButtons,
      [withStyle({ text: '❌ Reject', callback_data: `reject_${requestId}` }, 'danger')],
    ],
  };
};

// ── Register handlers ─────────────────────────────────────────────────────────

const registerUserHandlers = (bot) => {

  bot.use(async (ctx, next) => {
    if (ctx.chat?.type !== 'private') return next();

    const sender = await User.findOne({ telegramId: ctx.from.id }).select('role').lean().catch(() => null);
    const senderRole = String(sender?.role || 'user').toLowerCase();
    const shouldProtectByDefault =
      String(process.env.PROTECT_BOT_MESSAGES || 'true').toLowerCase() === 'true' &&
      senderRole === 'user';

    const incomingUserMessageId = ctx.message?.message_id;
    let userMessageDeleted = false;
    const originalReply = ctx.reply.bind(ctx);

    ctx.reply = async (text, extra) => {
      const safeExtra = {
        ...(extra || {}),
        protect_content: typeof extra?.protect_content === 'undefined'
          ? shouldProtectByDefault
          : extra.protect_content,
      };

      const hasInlineButtons = Array.isArray(safeExtra?.reply_markup?.inline_keyboard)
        && safeExtra.reply_markup.inline_keyboard.length > 0;

      if (!hasInlineButtons) {
        safeExtra.reply_markup = {
          inline_keyboard: [[withStyle(Markup.button.callback('🏠 Main Menu', 'back_to_main'), 'primary')]],
        };
      }

      const sent = await originalReply(text, safeExtra);

      if (incomingUserMessageId && !userMessageDeleted) {
        userMessageDeleted = true;
        await ctx.telegram.deleteMessage(ctx.chat.id, incomingUserMessageId).catch(() => { });
      }

      await replacePreviousBotReply(ctx, ctx.chat.id, sent);
      return sent;
    };

    return next();
  });

  const mainMenuKeyboard = () => Markup.inlineKeyboard([
    [withStyle(Markup.button.callback('📋 Check Plans', 'check_plans'), 'success')],
    [withStyle(Markup.button.callback('✅ Already Paid for premium', 'already_paid_menu'), 'success')],
    [withStyle(Markup.button.callback('📱 More Menu', 'more_menu'), 'primary')],
  ]);

  const checkPlansKeyboard = () => Markup.inlineKeyboard([
    [withStyle(Markup.button.callback('🎬 Movie Plan', 'plan_menu_movie'), 'primary')],
    [withStyle(Markup.button.callback('🔥 Desi Po*n Plan', 'plan_menu_desi'), 'primary')],
    [withStyle(Markup.button.callback('🌍 Non-Desi Po*n Plan', 'plan_menu_non_desi'), 'primary')],
    [withStyle(Markup.button.callback('⬅️ Back Button', 'back_to_main'), 'success')],
  ]);

  const moreMenuKeyboard = () => Markup.inlineKeyboard([
    [withStyle(Markup.button.callback('📊 Check Subscription Status', 'check_status'), 'primary')],
    [withStyle(Markup.button.callback('🎁 View Current Offers', 'view_offers'), 'primary')],
    [withStyle(Markup.button.callback('🔗 My referal link', 'my_referral'), 'primary')],
    [withStyle(Markup.button.callback('🛍 Seller Program', 'seller_program'), 'primary')],
    [Markup.button.callback('🎫 Contact Support', 'open_support')],
    [withStyle(Markup.button.callback('⬅️ Back button', 'back_to_main'), 'success')],
  ]);

  const premiumSelectionKeyboard = () => Markup.inlineKeyboard([
    [withStyle(Markup.button.callback('🎬 Movie Premium', 'request_premium_movie'), 'success')],
    [withStyle(Markup.button.callback('🔥 Desi Premium', 'request_premium_desi'), 'success')],
    [withStyle(Markup.button.callback('🌍 Non Desi Premium', 'request_premium_non_desi'), 'success')],
    [Markup.button.callback('🎫 Support Chat', 'open_support')],
  ]);

  const renewCategoryKeyboard = (categories) => {
    const rows = [];
    if (categories.includes(PLAN_CATEGORY.MOVIE)) {
      rows.push([withStyle(Markup.button.callback('🔄 Renew Movie Premium', 'status_renew_movie'), 'success')]);
    }
    if (categories.includes(PLAN_CATEGORY.DESI)) {
      rows.push([withStyle(Markup.button.callback('🔄 Renew Desi Premium', 'status_renew_desi'), 'success')]);
    }
    if (categories.includes(PLAN_CATEGORY.NON_DESI)) {
      rows.push([withStyle(Markup.button.callback('🔄 Renew Non Desi Premium', 'status_renew_non_desi'), 'success')]);
    }
    rows.push([withStyle(Markup.button.callback('🏠 Main Menu', 'back_to_main'), 'primary')]);
    return Markup.inlineKeyboard(rows);
  };

  const getCategoryPlans = async (category) => {
    const normalizedCategory = normalizePlanCategory(category);
    return Plan.find({
      isActive: true,
      category: normalizedCategory,
    }).sort({ durationDays: 1 });
  };

  const buildCategoryPlansText = async (category) => {
    const plans = await getCategoryPlans(category);
    const title = PLAN_CATEGORY_BUTTON_LABELS[normalizePlanCategory(category)] || getPlanCategoryLabel(category);
    const bestOffer = await getBestPublicOffer();

    if (!plans.length) {
      return `📋 ${title}\n\nNo active plans found for this category right now.\nPlease contact support from More Menu.`;
    }

    let text = `📋 ${title}\n\n`;
    plans.forEach((plan, index) => {
      text += `${index + 1}. ${plan.name} — ${plan.durationDays} days`;
      if (plan.price) {
        if (bestOffer?.discountPercent > 0) {
          const discounted = getDiscountedPrice(plan.price, bestOffer.discountPercent);
          text += ` — ${strikeText(`₹${formatInr(plan.price)}`)} ₹${formatInr(discounted)} (${bestOffer.discountPercent}% OFF)`;
        } else {
          text += ` — ₹${formatInr(plan.price)}`;
        }
      }
      text += `\n`;
    });

    if (bestOffer?.discountPercent > 0) {
      text += `\n🎁 Offer Applied: ${bestOffer.discountPercent}% OFF (${bestOffer.title})\n`;
    }

    text += `\n✅ Payment karne ke baad niche Paid button pe click karein.`;
    return text;
  };

  const sendMainMenuMessage = async (ctx, userName = 'User') => {
    await ctx.reply(
      `👋 *Welcome, ${escapeMarkdown(userName)}!*\n\n` +
      `Premium lene ke liye pehle *Check Plans* pe tap karein.\n\n` +
      `Agr aapne pehle se payment kar diya hai, toh "*Already Paid for premium*" pe tap karke apna payment proof submit karein.\n\n`,
      {
        parse_mode: 'Markdown',
        ...mainMenuKeyboard(),
      }
    );
  };

  const submitPremiumRequest = async (ctx, category) => {
    const normalizedCategory = normalizePlanCategory(category);
    const categoryLabel = getPlanCategoryLabel(normalizedCategory);

    const user = await findOrCreateUser(ctx.from);
    await User.findByIdAndUpdate(user._id, { lastInteraction: new Date() });

    const sameCategoryActiveSub = await Subscription.findOne({
      telegramId: ctx.from.id,
      status: 'active',
      expiryDate: { $gt: new Date() },
      planCategory: normalizedCategory,
    });

    if (sameCategoryActiveSub) {
      await ctx.reply(
        `✅ *Aapka ${escapeMarkdown(categoryLabel)} subscription active hai!*\n\n` +
        `📋 Plan: *${sameCategoryActiveSub.planName}*\n` +
        `📅 Expires: *${formatDate(sameCategoryActiveSub.expiryDate)}*`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const sameCategoryPendingReq = await Request.findOne({
      telegramId: ctx.from.id,
      status: 'pending',
      requestCategory: normalizedCategory,
    });

    if (sameCategoryPendingReq) {
      await ctx.reply(
        `⏳ *${escapeMarkdown(categoryLabel)} request already submitted*\n\n` +
        `Admin aapki request verify kar rahe hain. Thoda wait karein.`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const userDoc = await User.findOne({ telegramId: ctx.from.id });
    const latestProof = userDoc?.meta?.latestPaymentProof;
    const proofReadyForCategory = normalizePlanCategory(userDoc?.meta?.paymentProofReadyForCategory);
    const bestPublicOffer = await getBestPublicOffer();
    if (!latestProof?.fileId) {
      await ctx.reply(
        `⚠️ Payment screenshot required.\n\n` +
        `Pehle *Check Plans* → plan select karein → *Paid* dabayein aur screenshot upload karein.`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    if (proofReadyForCategory !== normalizedCategory) {
      await ctx.reply(
        `⚠️ Fresh payment screenshot required.\n\n` +
        `Pehle *Check Plans* → *${escapeMarkdown(getPlanCategoryLabel(normalizedCategory))}* select karein → *Paid* dabayein aur naya screenshot upload karein.`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    if (normalizePlanCategory(latestProof.category) !== normalizedCategory) {
      await ctx.reply(
        `⚠️ Aapne alag category ka screenshot upload kiya hai.\n\n` +
        `Kripya *${escapeMarkdown(getPlanCategoryLabel(normalizedCategory))}* ke liye naya screenshot upload karein.`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const newRequest = await Request.create({
      userId: user._id,
      telegramId: ctx.from.id,
      status: 'pending',
      requestCategory: normalizedCategory,
      paymentProof: {
        fileId: latestProof.fileId,
        fileUniqueId: latestProof.fileUniqueId || null,
        sourceType: latestProof.sourceType || null,
        logMessageId: latestProof.logMessageId || null,
      },
    });

    const consumedOffer = await consumeOneTimeUserOffer(ctx.from.id, newRequest._id);
    if (consumedOffer) {
      await Request.findByIdAndUpdate(newRequest._id, {
        appliedUserOffer: {
          offerId: consumedOffer._id,
          title: consumedOffer.title,
          discountPercent: consumedOffer.discountPercent,
        },
      });
    }

    await User.findByIdAndUpdate(user._id, {
      status: 'pending',
      $set: { 'meta.awaitingPaymentScreenshot': false },
      $unset: {
        'meta.latestPaymentProof': '',
        'meta.paymentProofReadyForCategory': '',
        'meta.paymentCategory': '',
      },
    });

    await ctx.reply(
      `✅ *${escapeMarkdown(categoryLabel)} request submitted!*\n\n` +
      (latestProof?.fileId && bestPublicOffer?.discountPercent > 0
        ? `🎁 *Public offer applied:* ${escapeMarkdown(bestPublicOffer.title)} (${bestPublicOffer.discountPercent}% OFF)\n`
        : '') +
      (latestProof?.fileId && bestPublicOffer?.discountPercent > 0 ? `\n` : '') +
      `Admin aapki payment verify karke jaldi approval denge.\n\n` +
      (consumedOffer
        ? `🎁 *Private offer applied:* ${escapeMarkdown(consumedOffer.title)}${consumedOffer.discountPercent > 0 ? ` (*${consumedOffer.discountPercent}% OFF*)` : ''}\n\n`
        : '') +
      `⏱ Usually 20 minutes ke andar approval mil jata hai.`,
      { parse_mode: 'Markdown' }
    );

    const keyboard = await buildApprovalKeyboard(newRequest._id, normalizedCategory);
    const safeName = escapeMarkdown(user.name);
    const safeUsername = user.username ? `@${escapeMarkdown(user.username)}` : 'N/A';
    const referredByUser = user.referredBy || null;
    const referredBySeller = user.sellerReferredBy || null;

    const logMsg = await bot.telegram.sendMessage(
      process.env.LOG_CHANNEL_ID,
      `🆕 *New Premium Access Request*\n\n` +
      `📦 Category: *${escapeMarkdown(categoryLabel)}*\n` +
      `👤 Name: ${safeName}\n` +
      `🆔 User ID: \`${ctx.from.id}\`\n` +
      `📛 Username: ${safeUsername}\n` +
      `🤝 Referred By (User): \`${referredByUser || 'N/A'}\`\n` +
      `🛍 Referred By (Seller): \`${referredBySeller || 'N/A'}\`\n` +
      (bestPublicOffer?.discountPercent > 0
        ? `🎁 Public Offer: *${escapeMarkdown(bestPublicOffer.title)}* (${bestPublicOffer.discountPercent}% OFF)\n`
        : '') +
      (consumedOffer
        ? `🎁 Private Offer: *${escapeMarkdown(consumedOffer.title)}*${consumedOffer.discountPercent > 0 ? ` (*${consumedOffer.discountPercent}% OFF*)` : ''}\n`
        : '') +
      `🧾 Payment Proof Log Msg: \`${latestProof.logMessageId || 'N/A'}\`\n` +
      `🕒 Time: ${new Date().toLocaleString('en-IN')}`,
      { parse_mode: 'Markdown', reply_markup: keyboard }
    );

    await Request.findByIdAndUpdate(newRequest._id, { logMessageId: logMsg.message_id });
    logger.info(`New ${normalizedCategory} access request for user ${ctx.from.id}`);
  };

  // ── /start ─────────────────────────────────────────────────────────────────
  bot.start(async (ctx) => {
    try {
      const user = await findOrCreateUser(ctx.from);
      await User.findByIdAndUpdate(user._id, { lastInteraction: new Date() });

      // Referral: /start ref_XXXXXXXX
      const payload = ctx.startPayload;
      if (payload && payload.startsWith('seller_')) {
        await processSellerReferral(user, payload.replace('seller_', ''));
      } else if (payload && payload.startsWith('ref_')) {
        await processReferral(user, payload.replace('ref_', ''));
      }

      await sendMainMenuMessage(ctx, user.name);
    } catch (err) {
      logger.error(`/start error: ${err.message}`);
      await ctx.reply('❌ Something went wrong. Please try again.');
    }
  });

  bot.action('check_plans', async (ctx) => {
    await ctx.answerCbQuery();

    const baseKeyboard = checkPlansKeyboard().reply_markup?.inline_keyboard || [];
    const backRow = baseKeyboard.length ? [baseKeyboard[baseKeyboard.length - 1]] : [];
    const planRows = baseKeyboard.length ? baseKeyboard.slice(0, -1) : [];
    const keyboardWithSupport = Markup.inlineKeyboard([
      ...planRows,
      [withStyle(Markup.button.callback('🎫 Support Chat', 'open_support'), 'primary')],
      ...backRow,
    ]);

    await safeEditMessage(
      ctx,
      `📋 *Check Plans*\n\nApni pasand ka plan choose karein.\n\n` +
      `Plan se related koi issue ho to support se contact karein.`,
      {
        parse_mode: 'Markdown',
        ...keyboardWithSupport,
      }
    );
  });

  // ── More Menu ───────────────────────────────────────────────────────────────
  bot.action('more_menu', async (ctx) => {
    await ctx.answerCbQuery();
    await safeEditMessage(
      ctx,
      `📋 *More Menu*\n\nNiche diye gaye options me se koi bhi choose karein.`,
      {
        parse_mode: 'Markdown',
        ...moreMenuKeyboard(),
      }
    );
  });

  bot.action('already_paid_menu', async (ctx) => {
    await ctx.answerCbQuery();
    const premiumKeyboard = premiumSelectionKeyboard().reply_markup?.inline_keyboard || [];
    await safeEditMessage(
      ctx,
      `✅ *Already Paid for premium*\n\n` +
      `Jis category ke liye payment kiya hai us category ka button dabayein aur payment screenshot upload karein.`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          ...premiumKeyboard,
          [withStyle(Markup.button.callback('⬅️ Back', 'back_to_main'), 'success')],
        ]),
      }
    );
  });

  bot.action(/^plan_menu_(movie|desi|non_desi)$/, async (ctx) => {
    await ctx.answerCbQuery();
    try {
      const category = normalizePlanCategory(ctx.match[1]);
      const plansText = await buildCategoryPlansText(category);
      const activeCategorySub = await Subscription.findOne({
        telegramId: ctx.from.id,
        status: 'active',
        expiryDate: { $gt: new Date() },
        planCategory: category,
      });
      const plansMessage = activeCategorySub
        ? `${plansText}\n\n✅ You already have an active ${getPlanCategoryLabel(category)} subscription.\nIf you want to extend it, click *Renew*.`
        : plansText;
      const qrFileName = QR_ASSET_BY_CATEGORY[category];
      const qrPath = path.join(process.cwd(), 'assets', qrFileName);
      const paidRows = [];
      if (activeCategorySub) {
        paidRows.push([withStyle(Markup.button.callback(`🔄 Renew ${getPlanCategoryLabel(category)}`, `status_renew_${category}`), 'success')]);
      }
      paidRows.push([withStyle(Markup.button.callback('✅ Paid', `paid_${category}`), 'success')]);
      paidRows.push([withStyle(Markup.button.callback('🏠 Main Menu', 'back_to_main'), 'primary')]);
      const paidKeyboard = Markup.inlineKeyboard(paidRows);

      if (fs.existsSync(qrPath)) {
        await ctx.replyWithPhoto(
          { source: qrPath },
          {
            caption: plansMessage,
            ...paidKeyboard,
          }
        );
      } else {
        await ctx.reply(
          `${plansMessage}\n\n⚠️ QR image missing: ${qrFileName} (assets folder).`,
          {
            ...paidKeyboard,
          }
        );
      }
    } catch (err) {
      logger.error(`plan_menu error: ${err.message}`);
      await ctx.reply('❌ Plan fetch failed. Please try again.');
    }
  });

  bot.action(/^paid_(movie|desi|non_desi)$/, async (ctx) => {
    await ctx.answerCbQuery();
    try {
      const callbackMessageId = ctx.callbackQuery?.message?.message_id;
      const callbackChatId = ctx.callbackQuery?.message?.chat?.id;
      const category = normalizePlanCategory(ctx.match[1]);
      await User.findOneAndUpdate(
        { telegramId: ctx.from.id },
        {
          $set: {
            'meta.awaitingPaymentScreenshot': true,
            'meta.paymentCategory': category,
            'meta.paymentFlowType': 'new_request',
          },
          $unset: {
            'meta.paymentProofReadyForCategory': '',
            'meta.renewalPlanId': '',
          },
        },
        { upsert: false }
      );

      await ctx.reply(
        `📸 *Payment screenshot upload karein*\n\n` +
        `Aapne *${escapeMarkdown(getPlanCategoryLabel(category))}* select kiya hai.\n` +
        `Ab payment screenshot photo/document bhejiye.` +
        `🚫 Agar aapne fake screenshot upload kiya to aap hamesha k liye ban ho jaogye.\n\n`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [withStyle(Markup.button.callback('❌ Cancel Upload', 'cancel_payment_upload'), 'danger')],
            [withStyle(Markup.button.callback('🏠 Main Menu', 'back_to_main'), 'primary')],
          ]),
        }
      );

      if (callbackChatId && callbackMessageId) {
        await ctx.telegram.deleteMessage(callbackChatId, callbackMessageId).catch(() => { });
      }
    } catch (err) {
      logger.error(`paid action error: ${err.message}`);
      await ctx.reply('❌ Unable to process. Please try again.');
    }
  });

  bot.action('cancel_payment_upload', async (ctx) => {
    await ctx.answerCbQuery('Upload cancelled');
    try {
      await User.findOneAndUpdate(
        { telegramId: ctx.from.id },
        {
          $set: { 'meta.awaitingPaymentScreenshot': false },
          $unset: {
            'meta.paymentCategory': '',
            'meta.paymentProofReadyForCategory': '',
            'meta.paymentFlowType': '',
            'meta.renewalPlanId': '',
          },
        }
      );

      await ctx.reply(
        `✅ Screenshot upload mode cancelled.\n\n` +
        `Aap dubara plan choose karke continue kar sakte hain.`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [withStyle(Markup.button.callback('📋 Check Plans', 'check_plans'), 'success')],
            [withStyle(Markup.button.callback('🏠 Main Menu', 'back_to_main'), 'primary')],
          ]),
        }
      );
    } catch (err) {
      logger.error(`cancel_payment_upload error: ${err.message}`);
      await ctx.reply('❌ Unable to cancel upload mode right now. Please try again.');
    }
  });

  // ── Seller Program ───────────────────────────────────────────────────────
  const showSellerProgram = async (ctx) => {
    const summary = await getSellerProgramSummary(ctx.from.id);
    if (!summary) return ctx.reply('❌ User not found. Please use /start first.');

    const botInfo = await bot.telegram.getMe();
    await ctx.reply(
      formatSellerProgramMessage(summary, botInfo.username),
      {
        parse_mode: 'Markdown',
        ...sellerProgramKeyboard(summary.isSeller, summary.canWithdraw),
      }
    );
  };

  bot.action('seller_program', async (ctx) => {
    await ctx.answerCbQuery();
    await showSellerProgram(ctx);
  });

  bot.action('register_seller', async (ctx) => {
    await ctx.answerCbQuery('Registering...');
    try {
      await registerSellerProgram(ctx.from.id);
      await showSellerProgram(ctx);
    } catch (err) {
      logger.error(`register_seller error: ${err.message}`);
      await ctx.reply('❌ Seller registration failed. Please try again.');
    }
  });

  bot.command('seller', showSellerProgram);

  bot.action('seller_withdraw', async (ctx) => {
    await ctx.answerCbQuery('Processing...');
    try {
      const req = await requestSellerWithdrawal(ctx.from.id);
      await notifySellerWithdrawalRequest(bot, ctx, req);
      await ctx.reply(
        `✅ *Withdrawal Request Submitted*\n\n` +
        `Request ID: \`${req._id}\`\n` +
        `Amount: *₹${Number(req.amount).toFixed(2)}*\n\n` +
        `Admin review ke baad payout process hoga.`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      await ctx.reply(`⚠️ ${err.message}`);
    }
  });

  bot.command('sellerwithdraw', async (ctx) => {
    try {
      const req = await requestSellerWithdrawal(ctx.from.id);
      await notifySellerWithdrawalRequest(bot, ctx, req);
      await ctx.reply(
        `✅ Withdrawal request created. ID: \`${req._id}\` | Amount: *₹${Number(req.amount).toFixed(2)}*`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      await ctx.reply(`⚠️ ${err.message}`);
    }
  });

  // ── Back to main menu (same message) ────────────────────────────────────────
  bot.action('back_to_main', async (ctx) => {
    await ctx.answerCbQuery();
    const callbackMessageId = ctx.callbackQuery?.message?.message_id;
    const callbackChatId = ctx.callbackQuery?.message?.chat?.id;

    await sendMainMenuMessage(ctx, ctx.from?.first_name || 'User');

    if (callbackChatId && callbackMessageId) {
      await ctx.telegram.deleteMessage(callbackChatId, callbackMessageId).catch(() => { });
    }
  });

  // ── Premium access callbacks ───────────────────────────────────────────────
  bot.action('request_access', async (ctx) => {
    await ctx.answerCbQuery();
    try {
      await safeEditMessage(
        ctx,
        `✅ *Already Paid for premium*\n\nApna premium type choose karein:`,
        {
          parse_mode: 'Markdown',
          ...premiumSelectionKeyboard(),
        }
      );
    } catch (err) {
      logger.error(`request_access error: ${err.message}`);
      await ctx.reply('❌ An error occurred. Please try again.');
    }
  });

  bot.action('request_premium_movie', async (ctx) => {
    await ctx.answerCbQuery('Submitting...');
    try {
      await submitPremiumRequest(ctx, PLAN_CATEGORY.MOVIE);
    } catch (err) {
      logger.error(`request_premium_movie error: ${err.message}`);
      await ctx.reply('❌ Request failed. Please try again.');
    }
  });

  bot.action('request_premium_desi', async (ctx) => {
    await ctx.answerCbQuery('Submitting...');
    try {
      await submitPremiumRequest(ctx, PLAN_CATEGORY.DESI);
    } catch (err) {
      logger.error(`request_premium_desi error: ${err.message}`);
      await ctx.reply('❌ Request failed. Please try again.');
    }
  });

  bot.action('request_premium_non_desi', async (ctx) => {
    await ctx.answerCbQuery('Submitting...');
    try {
      await submitPremiumRequest(ctx, PLAN_CATEGORY.NON_DESI);
    } catch (err) {
      logger.error(`request_premium_non_desi error: ${err.message}`);
      await ctx.reply('❌ Request failed. Please try again.');
    }
  });

  // ── Renewal (plan select → screenshot → admin approval) ───────────────────
  bot.action(/^renew_request_(?:(movie|desi|non_desi)_)?(.+)$/, async (ctx) => {
    await ctx.answerCbQuery('Continue with payment screenshot...');
    try {
      const categoryFromCallback = normalizePlanCategory(ctx.match[1] || PLAN_CATEGORY.GENERAL);
      const planId = ctx.match[2];
      const user = await findOrCreateUser(ctx.from);
      await User.findByIdAndUpdate(user._id, { lastInteraction: new Date() });

      const plan = await Plan.findById(planId);
      if (!plan) return ctx.reply('❌ Plan not found. Please try again.');

      const renewalCategory = normalizePlanCategory(plan.category || categoryFromCallback);
      if (ctx.match[1] && renewalCategory !== categoryFromCallback) {
        return ctx.reply('❌ Selected plan category mismatch. Please retry renewal from status.');
      }

      const activeOrGraceSub = await Subscription.findOne({
        telegramId: ctx.from.id,
        status: { $in: ['active', 'grace'] },
        planCategory: renewalCategory,
      });
      if (!activeOrGraceSub) {
        return ctx.reply(
          `⚠️ Aapke paas *${escapeMarkdown(getPlanCategoryLabel(renewalCategory))}* ka active/grace subscription nahi hai.\n\n` +
          `Renew karne ke liye pehle us category ka active plan hona chahiye.`,
          { parse_mode: 'Markdown' }
        );
      }

      const existingPending = await Request.findOne({
        telegramId: ctx.from.id,
        status: 'pending',
        requestCategory: renewalCategory,
      });
      if (existingPending) {
        return ctx.reply(
          `⏳ *${escapeMarkdown(getPlanCategoryLabel(renewalCategory))} renewal pending hai!*\n\n` +
          `Admin approval ka wait kijiye.`,
          { parse_mode: 'Markdown' }
        );
      }

      await User.findByIdAndUpdate(
        user._id,
        {
          $set: {
            'meta.awaitingPaymentScreenshot': true,
            'meta.paymentCategory': renewalCategory,
            'meta.paymentFlowType': 'renewal',
            'meta.renewalPlanId': String(plan._id),
          },
          $unset: {
            'meta.paymentProofReadyForCategory': '',
            'meta.latestPaymentProof': '',
          },
        }
      );

      const callbackMessageId = ctx.callbackQuery?.message?.message_id;
      const callbackChatId = ctx.callbackQuery?.message?.chat?.id;
      const bestOffer = await getBestPublicOffer();
      const discountedRenewalPrice = bestOffer?.discountPercent > 0
        ? getDiscountedPrice(plan.price, bestOffer.discountPercent)
        : plan.price;

      await ctx.reply(
        `📸 *Renewal Payment Screenshot Upload Karein*\n\n` +
        `Category: *${escapeMarkdown(getPlanCategoryLabel(renewalCategory))}*\n` +
        `Plan: *${escapeMarkdown(plan.name)}* (${plan.durationDays} days${plan.price ? ` · ₹${formatInr(plan.price)}` : ''})\n` +
        (plan.price && bestOffer?.discountPercent > 0
          ? `🎁 Offer: *${escapeMarkdown(bestOffer.title)}* (${bestOffer.discountPercent}% OFF)\n` +
          `💰 Payable: *₹${formatInr(discountedRenewalPrice)}*\n\n`
          : '\n') +
        `Ab payment screenshot photo/document bhejiye.`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [withStyle(Markup.button.callback('❌ Cancel Upload', 'cancel_payment_upload'), 'danger')],
            [withStyle(Markup.button.callback('🏠 Main Menu', 'back_to_main'), 'primary')],
          ]),
        }
      );

      if (callbackChatId && callbackMessageId) {
        await ctx.telegram.deleteMessage(callbackChatId, callbackMessageId).catch(() => { });
      }
    } catch (err) {
      logger.error(`renew_request error: ${err.message}`);
    }
  });

  // ── /status + check_status button ─────────────────────────────────────────
  const showStatus = async (ctx) => {
    try {
      await User.findOneAndUpdate({ telegramId: ctx.from.id }, { lastInteraction: new Date() });

      const activeSubs = await Subscription.find({
        telegramId: ctx.from.id,
        status: 'active',
        expiryDate: { $gt: new Date() },
      }).sort({ expiryDate: 1 });

      if (activeSubs.length) {
        const activeCategories = [...new Set(activeSubs.map((sub) => normalizePlanCategory(sub.planCategory || 'general')))]
          .filter((category) => [PLAN_CATEGORY.MOVIE, PLAN_CATEGORY.DESI, PLAN_CATEGORY.NON_DESI].includes(category));

        let message = `📊 *Your Subscription Status*\n\n` +
          `✅ Status: *Active*\n` +
          `📦 Active Plans: *${activeSubs.length}*\n\n`;

        for (let index = 0; index < activeSubs.length; index += 1) {
          const sub = activeSubs[index];
          const category = normalizePlanCategory(sub.planCategory || 'general');
          const groupId = sub.premiumGroupId || getGroupIdForCategory(category);
          const inGroup = groupId ? await isGroupMember(bot, groupId, ctx.from.id) : false;
          const remaining = daysRemaining(sub.expiryDate);

          message +=
            `${index + 1}. *${escapeMarkdown(getPlanCategoryLabel(category))}*\n` +
            `📋 Plan: *${escapeMarkdown(sub.planName)}*\n` +
            `📅 Expires on: *${formatDate(sub.expiryDate)}*\n` +
            `⏳ Days Remaining: *${remaining} days*\n` +
            `👥 Group Status: *${inGroup ? 'Joined' : 'Not Joined'}*\n`;

          if (!inGroup) {
            message +=
              `⚠️ Rejoin penalty for this category: *₹${REJOINING_PENALTY}*\n` +
              `Support: /support\n`;
          }

          message += '\n';
        }

        return ctx.reply(
          message + `💡 Renew karne ke liye niche category select karein.`,
          {
            parse_mode: 'Markdown',
            ...renewCategoryKeyboard(activeCategories),
          }
        );
      }

      const graceSub = await Subscription.findOne({ telegramId: ctx.from.id, status: 'grace' });
      if (graceSub) {
        const daysOverdue = Math.floor((new Date() - graceSub.expiryDate) / (1000 * 60 * 60 * 24));
        const graceDays = parseInt(process.env.GRACE_PERIOD_DAYS) || 3;
        const left = Math.max(0, graceDays - daysOverdue);
        const plans = await Plan.find({ isActive: true, category: normalizePlanCategory(graceSub.planCategory || 'general') }).sort({ durationDays: 1 });
        return ctx.reply(
          `⚠️ *Subscription Expired — Grace Period*\n\n` +
          `Your subscription expired ${daysOverdue} day(s) ago.\n` +
          `⏳ *${left} grace day(s)* k baad aap group se remove ho jayenge.\n\n` +
          `Apne premium ko renew karne ke liye niche diye gaye plans se select karein:`,
          {
            parse_mode: 'Markdown',
            reply_markup: plans.length ? renewalKeyboard(plans) : undefined,
          }
        );
      }

      await ctx.reply(
        `❌ *No Active Subscription*\n\n` +
        `Aapka koi subscription active nahi hai.\n` +
        `Niche diye gaye button pe click karein premium join request:`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [withStyle(Markup.button.callback('🌟 Request Access', 'request_access'), 'success')],
          ]),
        }
      );
    } catch (err) {
      logger.error(`showStatus error: ${err.message}`);
    }
  };

  bot.command('status', showStatus);
  bot.action('check_status', async (ctx) => {
    await ctx.answerCbQuery();
    await showStatus(ctx);
  });

  bot.action(/^status_renew_(movie|desi|non_desi)$/, async (ctx) => {
    await ctx.answerCbQuery();
    try {
      const category = normalizePlanCategory(ctx.match[1]);
      const activeSub = await Subscription.findOne({
        telegramId: ctx.from.id,
        status: 'active',
        expiryDate: { $gt: new Date() },
        planCategory: category,
      });
      if (!activeSub) {
        return safeEditMessage(
          ctx,
          `⚠️ *${escapeMarkdown(getPlanCategoryLabel(category))}* currently active nahi hai.\n\n` +
          `Renew button sirf active categories ke liye available hai.`,
          {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
              [withStyle(Markup.button.callback('⬅️ Back to Status', 'check_status'), 'success')],
              [withStyle(Markup.button.callback('🏠 Main Menu', 'back_to_main'), 'primary')],
            ]),
          }
        );
      }

      const plans = await Plan.find({ isActive: true, category }).sort({ durationDays: 1 });
      const bestOffer = await getBestPublicOffer();
      const categoryLabel = getPlanCategoryLabel(category);

      if (!plans.length) {
        return safeEditMessage(
          ctx,
          `⚠️ *${escapeMarkdown(categoryLabel)}* ke liye abhi active renewal plans available nahi hain.\n\n` +
          `Please support se contact karein.`,
          {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
              [withStyle(Markup.button.callback('⬅️ Back to Status', 'check_status'), 'success')],
              [withStyle(Markup.button.callback('🏠 Main Menu', 'back_to_main'), 'primary')],
            ]),
          }
        );
      }

      const keyboard = {
        inline_keyboard: [
          ...plans.map((plan) => ([withStyle({
            text: (() => {
              if (!plan.price) return `🔄 Renew ${plan.durationDays} Days`;
              if (bestOffer?.discountPercent > 0) {
                const discounted = getDiscountedPrice(plan.price, bestOffer.discountPercent);
                return `🔄 Renew ${plan.durationDays} Days · ₹${formatInr(discounted)}`;
              }
              return `🔄 Renew ${plan.durationDays} Days · ₹${formatInr(plan.price)}`;
            })(),
            callback_data: `renew_request_${category}_${plan._id}`,
          }, 'success')])),
          [withStyle(Markup.button.callback('⬅️ Back to Status', 'check_status'), 'success')],
          [withStyle(Markup.button.callback('🏠 Main Menu', 'back_to_main'), 'primary')],
        ],
      };

      await safeEditMessage(
        ctx,
        `🔄 *${escapeMarkdown(categoryLabel)} Renewal*\n\n` +
        `Niche se plan select karein:`,
        {
          parse_mode: 'Markdown',
          reply_markup: keyboard,
        }
      );
    } catch (err) {
      logger.error(`status_renew action error: ${err.message}`);
      await ctx.reply('❌ Renewal options load nahi ho paye. Please try again.');
    }
  });

  // ── View Plans + Offers ───────────────────────────────────────────────────
  bot.action('view_plans_offers', async (ctx) => {
    await ctx.answerCbQuery();
    try {
      await User.findOneAndUpdate({ telegramId: ctx.from.id }, { lastInteraction: new Date() });

      const plans = await getActivePlans();
      const offers = await getActiveOffers();

      let message = `📋 *Plans ki Jankari*\n\n`;

      if (!plans.length) {
        message += `Plan check karne k liye /start type karen\n\n`;
      } else {
        plans.forEach((plan, i) => {
          message += `${i + 1}. *${escapeMarkdown(plan.name)}* — ${plan.durationDays} days`;
          if (plan.price) message += ` — ₹${plan.price}`;
          message += `\n`;
        });
        message += `\n`;
      }

      message += `🎁 *Current Offers*\n\n`;
      if (!offers.length) {
        message += `Koi active offer nahi hai abhi.`;
      } else {
        offers.forEach((offer, i) => {
          const days = Math.max(0, Math.ceil((new Date(offer.validTill) - new Date()) / 86400000));
          message += `${i + 1}. *${escapeMarkdown(offer.title)}*\n`;
          message += `${escapeMarkdown(offer.description)}\n`;
          if (offer.discountPercent > 0) message += `💰 *${offer.discountPercent}% OFF*\n`;
          message += `⏰ Expires in *${days} day${days !== 1 ? 's' : ''}*\n\n`;
        });
      }

      await ctx.reply(message, { parse_mode: 'Markdown' });
    } catch (err) {
      logger.error(`view_plans_offers error: ${err.message}`);
      await ctx.reply('❌ Unable to fetch plans right now. Please try again.');
    }
  });

  // ── View Offers ────────────────────────────────────────────────────────────
  bot.action('view_offers', async (ctx) => {
    await ctx.answerCbQuery();
    try {
      await User.findOneAndUpdate({ telegramId: ctx.from.id }, { lastInteraction: new Date() });
      const offers = await getActiveOffers();
      const privateOffers = await UserOffer.find({
        targetTelegramId: ctx.from.id,
        isActive: true,
        isUsed: false,
        validTill: { $gt: new Date() },
      }).sort({ createdAt: -1 });

      if (!offers.length && !privateOffers.length) {
        return ctx.reply(
          `😔 *Koi active offers nahi hai abhi filhaal!*\n\n` +
          `New offer aane pe aapko notification mil jayega.`,
          { parse_mode: 'Markdown' }
        );
      }

      let message = `🎁 *Current Offers*\n\n`;
      if (privateOffers.length) {
        message += `⭐ *Your Private One-Time Offers*\n\n`;
        privateOffers.forEach((offer, i) => {
          const days = Math.max(0, Math.ceil((new Date(offer.validTill) - new Date()) / 86400000));
          message += `*${i + 1}. ${escapeMarkdown(offer.title)}*\n`;
          message += `${escapeMarkdown(offer.description)}\n`;
          if (offer.discountPercent > 0) message += `💰 *${offer.discountPercent}% OFF*\n`;
          message += `⏰ Expires in *${days} day${days !== 1 ? 's' : ''}*\n`;
          message += `ℹ️ *Auto-applies on your next request/renewal (one time only).*\n\n`;
        });
      }

      if (offers.length) {
        message += `🎁 *Public Offers*\n\n`;
      }
      offers.forEach((offer, i) => {
        const days = Math.max(0, Math.ceil((new Date(offer.validTill) - new Date()) / 86400000));
        message += `*${i + 1}. ${offer.title}*\n`;
        message += `${offer.description}\n`;
        if (offer.discountPercent > 0) message += `💰 *${offer.discountPercent}% OFF*\n`;
        message += `⏰ Expires in *${days} day${days !== 1 ? 's' : ''}*\n\n`;
      });

      await ctx.reply(message, { parse_mode: 'Markdown' });
    } catch (err) {
      logger.error(`view_offers error: ${err.message}`);
    }
  });

  // ── My Referral Link ───────────────────────────────────────────────────────
  bot.action('my_referral', async (ctx) => {
    await ctx.answerCbQuery();
    try {
      const user = await findOrCreateUser(ctx.from);
      const botInfo = await bot.telegram.getMe();
      const link = `https://t.me/${botInfo.username}?start=ref_${user.referralCode}`;
      const count = await User.countDocuments({ referredBy: ctx.from.id });

      await ctx.reply(
        `🤝 *Referral Program*\n\n` +
        `Share your link with friends.\n` +
        `When they subscribe, you earn *+${process.env.BONUS_REFERRAL_DAYS || 3} free days*!\n\n` +
        `🔗 *Your Link:*\n\`${link}\`\n\n` +
        `👥 Friends Referred: *${count}*`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      logger.error(`my_referral error: ${err.message}`);
    }
  });

  bot.command('referral', async (ctx) => {
    const user = await findOrCreateUser(ctx.from);
    const botInfo = await bot.telegram.getMe();
    const link = `https://t.me/${botInfo.username}?start=ref_${user.referralCode}`;
    const count = await User.countDocuments({ referredBy: ctx.from.id });
    await ctx.reply(
      `🤝 *Your Referral Link*\n\n\`${link}\`\n\n👥 Referrals: *${count}*`,
      { parse_mode: 'Markdown' }
    );
  });

  // ── SUPPORT CHAT (Topics-based) ────────────────────────────────────────────
  //
  // How it works for the USER:
  //   1. User taps "Contact Support" or sends /support
  //   2. Bot checks: already have open ticket? → just send messages
  //      If no open ticket → create topic + let them type
  //   3. Every message user sends is forwarded into the forum topic
  //   4. Admin replies in topic → bot sends reply to user's DM automatically
  //   5. User sends /cancel → chat ends, topic archived
  //
  // How it works for the ADMIN:
  //   → Just reply inside the forum topic thread. That's it.
  //   → Press "✅ Close Ticket" button in topic to end the chat.

  const openSupportChat = async (ctx) => {
    const userId = ctx.from.id;
    try {
      const user = await findOrCreateUser(ctx.from);
      await User.findOneAndUpdate({ telegramId: userId }, { lastInteraction: new Date() });

      // Case 1: Already has an open ticket → resume
      const existing = await getActiveTicket(userId);
      if (existing) {
        return ctx.reply(
          `💬 *Support Chat pehle se chalu hai*\n\n` +
          `Ticket: \`${existing.ticketId}\`\n\n` +
          `Apna message type kijiye — hamari tem jald hin reply karegi.\n\n` +
          `📌 Support chat close karne ke liye niche button use kijiye.`,
          {
            parse_mode: 'Markdown',
            ...supportCancelKeyboard(),
          }
        );
      }

      // Case 2: No open ticket → prompt for message
      // We set a flag in User doc so next message creates the ticket
      await User.findOneAndUpdate({ telegramId: userId }, { $set: { 'meta.awaitingSupport': true } });

      const supportCancelRows = supportCancelKeyboard().reply_markup?.inline_keyboard || [];

      await ctx.reply(
        `🎫 *Contact Support*\n\n` +
        `Hi ${user.name}! 👋\n\n` +

        `━━━━━━━━━━━━━━━━\n` +
        `📌 *Tips for faster help:*\n` +
        `• Apna samasya ko detail me likh k bhejen.\n` +
        `• Hamari support team jald hin reply karegi.\n` +
        `━━━━━━━━━━━━━━━━\n\n` +
        `Chat ko close karne ke liye niche button use kijiye!`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            ...supportCancelRows,
            [withStyle(Markup.button.callback('🏠 Main Menu', 'back_to_main'), 'primary')],
          ]),
        }
      );
    } catch (err) {
      logger.error(`openSupportChat error: ${err.message}`);
      await ctx.reply('❌ Something went wrong. Please try again.');
    }
  };

  bot.action('open_support', async (ctx) => {
    await ctx.answerCbQuery();
    await openSupportChat(ctx);
  });

  bot.command('support', openSupportChat);

  const onPaymentProofReceived = async (ctx, sourceType) => {
    if (ctx.chat?.type !== 'private') return;

    const userDoc = await User.findOne({ telegramId: ctx.from.id });
    if (!userDoc?.meta?.awaitingPaymentScreenshot) return;

    const category = normalizePlanCategory(userDoc?.meta?.paymentCategory);
    const paymentFlowType = String(userDoc?.meta?.paymentFlowType || 'new_request');
    const renewalPlanId = userDoc?.meta?.renewalPlanId || null;
    const categoryLabel = getPlanCategoryLabel(category);
    const safeName = escapeMarkdown(userDoc.name || ctx.from.first_name || 'User');
    const safeUsername = userDoc.username ? `@${escapeMarkdown(userDoc.username)}` : 'N/A';

    let fileId;
    let fileUniqueId;

    if (sourceType === 'photo') {
      const photos = ctx.message?.photo || [];
      const bestPhoto = photos[photos.length - 1];
      fileId = bestPhoto?.file_id;
      fileUniqueId = bestPhoto?.file_unique_id;
    } else {
      fileId = ctx.message?.document?.file_id;
      fileUniqueId = ctx.message?.document?.file_unique_id;
    }

    if (!fileId) {
      await ctx.reply('❌ Invalid screenshot. Please send a clear image.');
      return;
    }

    let proofLogMessageId = null;
    try {
      const caption =
        `🧾 *Payment Screenshot Submitted*\n\n` +
        `📦 Category: *${escapeMarkdown(categoryLabel)}*\n` +
        `👤 Name: ${safeName}\n` +
        `🆔 User ID: \`${ctx.from.id}\`\n` +
        `📛 Username: ${safeUsername}\n` +
        `🕒 Time: ${new Date().toLocaleString('en-IN')}`;

      const logMessage = sourceType === 'photo'
        ? await bot.telegram.sendPhoto(process.env.LOG_CHANNEL_ID, fileId, { caption, parse_mode: 'Markdown' })
        : await bot.telegram.sendDocument(process.env.LOG_CHANNEL_ID, fileId, { caption, parse_mode: 'Markdown' });

      proofLogMessageId = logMessage?.message_id || null;
    } catch (err) {
      logger.error(`payment proof log error: ${err.message}`);
    }

    if (paymentFlowType === 'renewal' && renewalPlanId) {
      const user = await findOrCreateUser(ctx.from);
      const plan = await Plan.findById(renewalPlanId);
      if (!plan) {
        await User.findOneAndUpdate(
          { telegramId: ctx.from.id },
          {
            $set: { 'meta.awaitingPaymentScreenshot': false },
            $unset: {
              'meta.paymentCategory': '',
              'meta.paymentFlowType': '',
              'meta.renewalPlanId': '',
            },
          }
        );
        await ctx.reply('❌ Renewal plan not found. Please open status and retry renewal.');
        return;
      }

      const renewalCategory = normalizePlanCategory(plan.category || category);
      if (renewalCategory !== category) {
        await User.findOneAndUpdate(
          { telegramId: ctx.from.id },
          {
            $set: { 'meta.awaitingPaymentScreenshot': false },
            $unset: {
              'meta.paymentCategory': '',
              'meta.paymentFlowType': '',
              'meta.renewalPlanId': '',
            },
          }
        );
        await ctx.reply('❌ Renewal category mismatch. Please retry renewal from status.');
        return;
      }

      const existingPending = await Request.findOne({
        telegramId: ctx.from.id,
        status: 'pending',
        requestCategory: renewalCategory,
      });
      if (existingPending) {
        await User.findOneAndUpdate(
          { telegramId: ctx.from.id },
          {
            $set: { 'meta.awaitingPaymentScreenshot': false },
            $unset: {
              'meta.paymentCategory': '',
              'meta.paymentFlowType': '',
              'meta.renewalPlanId': '',
            },
          }
        );
        await ctx.reply(
          `⏳ *${escapeMarkdown(getPlanCategoryLabel(renewalCategory))} renewal pending hai!*\n\n` +
          `Admin approval ka wait kijiye.`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      const renewalReq = await Request.create({
        userId: user._id,
        telegramId: ctx.from.id,
        status: 'pending',
        requestCategory: renewalCategory,
        selectedPlanId: plan._id,
        paymentProof: {
          fileId,
          fileUniqueId,
          sourceType,
          logMessageId: proofLogMessageId,
        },
      });

      const consumedOffer = await consumeOneTimeUserOffer(ctx.from.id, renewalReq._id);
      const bestOffer = await getBestPublicOffer();
      if (consumedOffer) {
        await Request.findByIdAndUpdate(renewalReq._id, {
          appliedUserOffer: {
            offerId: consumedOffer._id,
            title: consumedOffer.title,
            discountPercent: consumedOffer.discountPercent,
          },
        });
      }

      await User.findByIdAndUpdate(user._id, {
        $set: { 'meta.awaitingPaymentScreenshot': false },
        $unset: {
          'meta.latestPaymentProof': '',
          'meta.paymentProofReadyForCategory': '',
          'meta.paymentCategory': '',
          'meta.paymentFlowType': '',
          'meta.renewalPlanId': '',
        },
      });

      await ctx.reply(
        `✅ *${escapeMarkdown(categoryLabel)} renewal request submitted!*\n\n` +
        `📋 Plan: *${escapeMarkdown(plan.name)}* (${plan.durationDays} days${plan.price ? ` · ₹${formatInr(plan.price)}` : ''})\n` +
        (plan.price && bestOffer?.discountPercent > 0
          ? `🎁 *Public offer applied:* ${escapeMarkdown(bestOffer.title)} (${bestOffer.discountPercent}% OFF)\n` +
          `💰 Price: ~₹${formatInr(plan.price)}~ → *₹${formatInr(getDiscountedPrice(plan.price, bestOffer.discountPercent))}*\n\n`
          : '\n') +
        (consumedOffer
          ? `🎁 *Private offer applied:* ${escapeMarkdown(consumedOffer.title)}${consumedOffer.discountPercent > 0 ? ` (*${consumedOffer.discountPercent}% OFF*)` : ''}\n\n`
          : '') +
        `Admin screenshot verify karke approval denge. Approval ke baad isi category plan me days add honge.`,
        { parse_mode: 'Markdown' }
      );

      const safePlanName = escapeMarkdown(plan.name);
      const logMsg = await bot.telegram.sendMessage(
        process.env.LOG_CHANNEL_ID,
        `🔄 *Renewal Request*\n\n` +
        `📦 Category: *${escapeMarkdown(categoryLabel)}*\n` +
        `👤 Name: ${safeName}\n` +
        `🆔 ID: \`${ctx.from.id}\`\n` +
        `📛 Username: ${safeUsername}\n` +
        (plan.price && bestOffer?.discountPercent > 0
          ? `🎁 Public Offer: *${escapeMarkdown(bestOffer.title)}* (${bestOffer.discountPercent}% OFF)\n` +
          `💰 Price: ~₹${formatInr(plan.price)}~ → *₹${formatInr(getDiscountedPrice(plan.price, bestOffer.discountPercent))}*\n`
          : '') +
        (consumedOffer
          ? `🎁 Private Offer: *${escapeMarkdown(consumedOffer.title)}*${consumedOffer.discountPercent > 0 ? ` (*${consumedOffer.discountPercent}% OFF*)` : ''}\n`
          : '') +
        `📋 Plan: ${safePlanName} (${plan.durationDays} days${plan.price ? ` · ₹${formatInr(plan.price)}` : ''})\n` +
        `🧾 Payment Proof Log Msg: \`${proofLogMessageId || 'N/A'}\`\n` +
        `🕒 Time: ${new Date().toLocaleString('en-IN')}`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[
              withStyle({ text: '✅ Approve', callback_data: `approve_${renewalReq._id}_${plan._id}` }, 'success'),
              withStyle({ text: '❌ Reject', callback_data: `reject_${renewalReq._id}` }, 'danger'),
            ]],
          },
        }
      );

      await Request.findByIdAndUpdate(renewalReq._id, { logMessageId: logMsg.message_id });
      return;
    }

    await User.findOneAndUpdate(
      { telegramId: ctx.from.id },
      {
        $set: {
          'meta.awaitingPaymentScreenshot': false,
          'meta.paymentProofReadyForCategory': category,
          'meta.latestPaymentProof': {
            fileId,
            fileUniqueId,
            sourceType,
            logMessageId: proofLogMessageId,
            category,
            uploadedAt: new Date(),
          },
        },
      }
    );

    await ctx.reply(
      `✅ Appka payment Screenshot receive ho gaya hai.\n\n` +
      `Aapne jis plan k liye payment kiya hai uska category *${escapeMarkdown(categoryLabel)}* pe tap karein.\n\n` +
      `Hamari team jald hi aapke screenshot ko verify karegi aur Joining link bhejegi.\n\n` +
      `Kripya intejaar karein.`,
      {
        parse_mode: 'Markdown',
        ...premiumSelectionKeyboard(),
      }
    );
  };

  bot.on('photo', async (ctx, next) => {
    try {
      await onPaymentProofReceived(ctx, 'photo');
    } catch (err) {
      logger.error(`payment proof photo handler error: ${err.message}`);
      await ctx.reply('❌ Screenshot process failed. Please try again.');
    }
    return next();
  });

  bot.on('document', async (ctx, next) => {
    try {
      const mime = String(ctx.message?.document?.mime_type || '').toLowerCase();
      if (!mime.startsWith('image/')) return next();
      await onPaymentProofReceived(ctx, 'document');
    } catch (err) {
      logger.error(`payment proof document handler error: ${err.message}`);
      await ctx.reply('❌ Screenshot process failed. Please try again.');
    }
    return next();
  });

  const closeSupportChat = async (ctx) => {
    const userId = ctx.from.id;
    try {
      await User.findOneAndUpdate({ telegramId: userId }, { $unset: { 'meta.awaitingSupport': '' } });

      const ticket = await getActiveTicket(userId);
      if (!ticket) {
        return ctx.reply(
          'ℹ️ Aapke paas koi open support chat nahi hai.',
          {
            ...Markup.inlineKeyboard([
              [withStyle(Markup.button.callback('🎫 Start Support Chat', 'open_support'), 'primary')],
              [withStyle(Markup.button.callback('🏠 Main Menu', 'back_to_main'), 'success')],
            ]),
          }
        );
      }

      await closeTicket(bot, ticket.topicId, null, true);
    } catch (err) {
      logger.error(`closeSupportChat error: ${err.message}`);
      await ctx.reply('❌ Error closing chat. Please try again.');
    }
  };

  bot.action('cancel_support', async (ctx) => {
    await ctx.answerCbQuery('Closing support chat...');
    await closeSupportChat(ctx);
  });

  // ── /cancel — user closes their support chat ──────────────────────────────
  bot.command('cancel', async (ctx) => {
    await closeSupportChat(ctx);
  });

  // ── Text handler: intercept user messages for active support chats ─────────
  bot.on('text', async (ctx, next) => {
    // Only process private messages (not group messages)
    if (ctx.chat.type !== 'private') return next();

    const userId = ctx.from.id;
    const text = ctx.message.text;

    // Skip commands
    if (text.startsWith('/')) return next();

    await User.findOneAndUpdate({ telegramId: userId }, { lastInteraction: new Date() }).catch(() => { });

    try {
      const user = await findOrCreateUser(ctx.from);

      // Check if user is awaiting support (about to create ticket)
      const userDoc = await User.findOne({ telegramId: userId });
      if (userDoc?.meta?.awaitingPaymentScreenshot) {
        return ctx.reply(
          `📸 Aap payment screenshot upload mode me hain.\n\n` +
          `Kripya screenshot as photo/document bhejiye ya cancel karein.`,
          {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
              [withStyle(Markup.button.callback('❌ Cancel Upload', 'cancel_payment_upload'), 'danger')],
              [withStyle(Markup.button.callback('🏠 Main Menu', 'back_to_main'), 'primary')],
            ]),
          }
        );
      }

      const isAwaiting = userDoc?.meta?.awaitingSupport === true;

      // Check if user already has an open ticket
      const activeTicket = await getActiveTicket(userId);

      if (!isAwaiting && !activeTicket) {
        return ctx.reply(
          `⚠️ *AK IMAX Premium*\n\n` +
          `Premium access lene ke liye pehle Plan Buy karen.\n` +
          `Niche diye gaye button pe click karein:`,
          {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
              [withStyle(Markup.button.callback('📋 View Plans & Offers', 'view_plans_offers'), 'primary')],
            ]),
          }
        );
      }

      if (isAwaiting && !activeTicket) {
        // First message — create the ticket and topic
        await User.findOneAndUpdate({ telegramId: userId }, { $unset: { 'meta.awaitingSupport': '' } });

        let ticket;
        ticket = await openTicket(bot, user, text);

        await ctx.reply(
          `✅ *Support Chat Connected!*\n\n` +
          `Ticket ID: \`${ticket.ticketId}\`\n\n` +
          `Our team has been notified and will reply to you here.\n` +
          `📌 Support chat close karne ke liye niche button use kijiye.`,
          {
            parse_mode: 'Markdown',
            ...supportCancelKeyboard(),
          }
        );

      } else if (activeTicket) {
        // Follow-up message — forward to existing topic
        if (isAwaiting) {
          await User.findOneAndUpdate({ telegramId: userId }, { $unset: { 'meta.awaitingSupport': '' } });
        }
        await forwardUserMessage(bot, activeTicket, user, text);
        // Small confirmation tick so user knows message was delivered
        await ctx.react('👍').catch(() => { }); // reaction if supported, else silent
      }

    } catch (err) {
      logger.error(`support text handler error: ${err.message}`);
      await ctx.reply('❌ Error sending message. Please try again.');
    }
  });
};

module.exports = { registerUserHandlers };
