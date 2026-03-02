// src/bot/handlers.js
// User-facing bot handlers:
//   /start  - welcome + referral processing
//   /status - subscription panel with renewal buttons
//   /support - Topics-based live support chat (1 per day)
//   /cancel  - user closes their own support chat
//   request_access, renew_request, view_offers, my_referral

const { Markup } = require('telegraf');
const User = require('../models/User');
const Request = require('../models/Request');
const Subscription = require('../models/Subscription');
const Plan = require('../models/Plan');

const { findOrCreateUser, getActiveSubscription, getPendingRequest } = require('../services/userService');
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
const logger = require('../utils/logger');

const REJOINING_PENALTY = process.env.REJOINING_PENALTY || '20';
const lastBotMessageByChat = new Map();

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Button coloring (Bot API 9.4+). Older clients ignore `style`.
 * Styles: 'primary' (blue), 'success' (green), 'danger' (red)
 */
const withStyle = (button, style) => ({ ...button, style });

const escapeMarkdown = (value) => {
  return String(value ?? '').replace(/([_*`\[])/g, '\\$1');
};

const isMessageNotModifiedError = (err) => {
  const message = err?.response?.description || err?.description || err?.message || '';
  return String(message).toLowerCase().includes('message is not modified');
};

const safeEditReplyMarkup = async (ctx, keyboard) => {
  try {
    await ctx.editMessageReplyMarkup(keyboard.reply_markup || keyboard);
  } catch (err) {
    if (!isMessageNotModifiedError(err)) throw err;
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

/**
 * Build the approval keyboard for log channel requests.
 * Uses real plans from DB if any exist; falls back to hardcoded day options.
 */
const buildApprovalKeyboard = async (requestId) => {
  const plans = await Plan.find({ isActive: true }).sort({ durationDays: 1 });

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
    planButtons = [[
      withStyle({ text: '30 Days', callback_data: `approve_${requestId}_30` }, 'success'),
      withStyle({ text: '90 Days', callback_data: `approve_${requestId}_90` }, 'success'),
      withStyle({ text: '180 Days', callback_data: `approve_${requestId}_180` }, 'success'),
      withStyle({ text: '365 Days', callback_data: `approve_${requestId}_365` }, 'success'),
    ]];
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

    const incomingUserMessageId = ctx.message?.message_id;
    let userMessageDeleted = false;
    const originalReply = ctx.reply.bind(ctx);

    ctx.reply = async (text, extra) => {
      const sent = await originalReply(text, extra);

      if (incomingUserMessageId && !userMessageDeleted) {
        userMessageDeleted = true;
        await ctx.telegram.deleteMessage(ctx.chat.id, incomingUserMessageId).catch(() => { });
      }

      await replacePreviousBotReply(ctx, ctx.chat.id, sent);
      return sent;
    };

    return next();
  });

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

      const isNew = new Date() - user.createdAt < 10000;

      await ctx.reply(
        `${isNew ? '👋 Welcome' : '👋 Welcome back'}, *${user.name}*!\n\n` +
        `Ye Apka *Premium Manager* BOT Hai.\n\n` +
        `Apne Premium Ke Liye Pay Kar Diya Hai To Niche Diye Gaye Button Pe Click Kro : Premium Join Request\n`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [withStyle(Markup.button.callback('🌟 Premium Access Request', 'request_access'), 'success')],
            [withStyle(Markup.button.callback('📋 More Menu', 'more_menu'), 'primary')],
          ]),
        }
      );
    } catch (err) {
      logger.error(`/start error: ${err.message}`);
      await ctx.reply('❌ Something went wrong. Please try again.');
    }
  });

  // ── More Menu ───────────────────────────────────────────────────────────────
  bot.action('more_menu', async (ctx) => {
    await ctx.answerCbQuery();
    // Replace buttons on the same welcome message
    const keyboard = Markup.inlineKeyboard([
      [withStyle(Markup.button.callback('📊 Check Subscription Status', 'check_status'), 'primary')],
      [withStyle(Markup.button.callback('🎁 View Current Offers', 'view_offers'), 'primary')],
      [withStyle(Markup.button.callback('🤝 My Referral Link', 'my_referral'), 'primary')],
      [withStyle(Markup.button.callback('🛍 Seller Program', 'seller_program'), 'primary')],
      [Markup.button.callback('🎫 Contact Support', 'open_support')],
      [withStyle(Markup.button.callback('⬅️ Back', 'back_to_main'), 'success')],
    ]);
    await safeEditReplyMarkup(ctx, keyboard);
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
    const keyboard = Markup.inlineKeyboard([
      [withStyle(Markup.button.callback('🌟 Premium Access Request', 'request_access'), 'success')],
      [withStyle(Markup.button.callback('📋 More Menu', 'more_menu'), 'primary')],
    ]);
    await safeEditReplyMarkup(ctx, keyboard);
  });

  // ── Request Premium Access ─────────────────────────────────────────────────
  bot.action('request_access', async (ctx) => {
    await ctx.answerCbQuery();
    try {
      const user = await findOrCreateUser(ctx.from);
      await User.findByIdAndUpdate(user._id, { lastInteraction: new Date() });

      const activeSub = await getActiveSubscription(ctx.from.id);
      if (activeSub) {
        return ctx.reply(
          `✅ *Aapka subscription active hai!*\n\n` +
          `📋 Plan: *${activeSub.planName}*\n` +
          `📅 Expires: *${formatDate(activeSub.expiryDate)}*`,
          { parse_mode: 'Markdown' }
        );
      }

      const pendingReq = await getPendingRequest(ctx.from.id);
      if (pendingReq) {
        return ctx.reply(
          `⏳ *Request Already Submitted*\n\n` +
          `Admin aapki request verify kar rahe hain.\n` +
          `Verification ke baad aapko jaldi se joining link mil jayega.\n\n` +
          `⏱  Usually 20 minutes ke andar approval mil jata hai. Thoda wait karein please.`,
          { parse_mode: 'Markdown' }
        );
      }

      const newRequest = await Request.create({
        userId: user._id,
        telegramId: ctx.from.id,
        status: 'pending',
      });

      await User.findByIdAndUpdate(user._id, { status: 'pending' });

      await ctx.reply(
        `✅ _Premium joining request successfully!_\n\n` +
        `Admin aapki payment verify kar rahe hain.\n\n` +
        `Verification ke baad aapko jaldi se joining link mil jayega.\n\n` +
        `⏱  Usually 20 minutes ke andar approval mil jata hai. Thoda wait karein please.`,
        { parse_mode: 'Markdown' }
      );

      const keyboard = await buildApprovalKeyboard(newRequest._id);
      const safeName = escapeMarkdown(user.name);
      const safeUsername = user.username ? `@${escapeMarkdown(user.username)}` : 'N/A';
      const referredByUser = user.referredBy || null;
      const referredBySeller = user.sellerReferredBy || null;
      const logMsg = await bot.telegram.sendMessage(
        process.env.LOG_CHANNEL_ID,
        `🆕 *New Premium Access Request*\n\n` +
        `👤 Name: ${safeName}\n` +
        `🆔 User ID: \`${ctx.from.id}\`\n` +
        `📛 Username: ${safeUsername}\n` +
        `🤝 Referred By (User): \`${referredByUser || 'N/A'}\`\n` +
        `🛍 Referred By (Seller): \`${referredBySeller || 'N/A'}\`\n` +
        `🎯 Referred To: \`${ctx.from.id}\`\n` +
        `🕒 Time: ${new Date().toLocaleString('en-IN')}`,
        { parse_mode: 'Markdown', reply_markup: keyboard }
      );

      await Request.findByIdAndUpdate(newRequest._id, { logMessageId: logMsg.message_id });
      logger.info(
        `New access request: referredByUser=${referredByUser || 'N/A'}, referredBySeller=${referredBySeller || 'N/A'}, referredTo=${ctx.from.id}`
      );
    } catch (err) {
      logger.error(`request_access error: ${err.message}`);
      await ctx.reply('❌ An error occurred. Please try again.');
    }
  });

  // ── One-click Renewal ──────────────────────────────────────────────────────
  bot.action(/^renew_request_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery('Submitting renewal...');
    try {
      const planId = ctx.match[1];
      const user = await findOrCreateUser(ctx.from);
      await User.findByIdAndUpdate(user._id, { lastInteraction: new Date() });

      const plan = await Plan.findById(planId);
      if (!plan) return ctx.reply('❌ Plan not found. Please try again.');

      const existing = await getPendingRequest(ctx.from.id);
      if (existing) {
        return ctx.reply(
          `⏳ *Renewal Pending hai!*\n\n` +
          `Admin approval ka wait kijiye.`,
          { parse_mode: 'Markdown' }
        );
      }

      const renewalReq = await Request.create({
        userId: user._id,
        telegramId: ctx.from.id,
        status: 'pending',
      });

      await ctx.reply(
        `🔄 *Aapka Renewal Request Submit Ho Gaya Hai!*\n\n` +
        `📋 Plan: *${plan.name}* (${plan.durationDays} days${plan.price ? ` · ₹${plan.price}` : ''})\n\n` +
        `Apko jald se jald notification mil jayega.`,
        { parse_mode: 'Markdown' }
      );

      const logMsg = await bot.telegram.sendMessage(
        process.env.LOG_CHANNEL_ID,
        (() => {
          const safeName = escapeMarkdown(user.name);
          const safeUsername = user.username ? `@${escapeMarkdown(user.username)}` : 'N/A';
          const safePlanName = escapeMarkdown(plan.name);
          return `🔄 *Renewal Request*\n\n` +
            `👤 Name: ${safeName}\n` +
            `🆔 ID: \`${ctx.from.id}\`\n` +
            `📛 Username: ${safeUsername}\n` +
            `📋 Plan: ${safePlanName} (${plan.durationDays} days${plan.price ? ` · ₹${plan.price}` : ''})`;
        })(),
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[
              withStyle({ text: `✅ Approve`, callback_data: `approve_${renewalReq._id}_${plan._id}` }, 'success'),
              withStyle({ text: '❌ Reject', callback_data: `reject_${renewalReq._id}` }, 'danger'),
            ]],
          },
        }
      );

      await Request.findByIdAndUpdate(renewalReq._id, { logMessageId: logMsg.message_id });
    } catch (err) {
      logger.error(`renew_request error: ${err.message}`);
    }
  });

  // ── /status + check_status button ─────────────────────────────────────────
  const showStatus = async (ctx) => {
    try {
      await User.findOneAndUpdate({ telegramId: ctx.from.id }, { lastInteraction: new Date() });

      const activeSub = await getActiveSubscription(ctx.from.id);
      if (activeSub) {
        const remaining = daysRemaining(activeSub.expiryDate);
        const plans = await getActivePlans();
        const inGroup = await isGroupMember(bot, process.env.PREMIUM_GROUP_ID, ctx.from.id);

        const groupWarning = !inGroup
          ? `\n⚠️ *Aap Premium Group Me Nahi Hai!*\n` +
          `Apne galti se leave kiya hai toh *₹${REJOINING_PENALTY}* dena parega.\n` +
          `Support se baat karne ke liye /support likhen.\n`
          : '';

        return ctx.reply(
          `📊 *Your Subscription*\n\n` +
          `✅ Status: *Active*\n` +
          `📋 Plan: *${activeSub.planName}*\n` +
          `📅 Expires on: *${formatDate(activeSub.expiryDate)}*\n` +
          `⏳ Days Remaining: *${remaining} days*\n` +
          groupWarning +
          (plans.length ? `\n💡 Aapko extend karna hai toh niche diye gaye plans se select karein:` : ''),
          {
            parse_mode: 'Markdown',
            reply_markup: plans.length ? renewalKeyboard(plans) : undefined,
          }
        );
      }

      const graceSub = await Subscription.findOne({ telegramId: ctx.from.id, status: 'grace' });
      if (graceSub) {
        const daysOverdue = Math.floor((new Date() - graceSub.expiryDate) / (1000 * 60 * 60 * 24));
        const graceDays = parseInt(process.env.GRACE_PERIOD_DAYS) || 3;
        const left = Math.max(0, graceDays - daysOverdue);
        const plans = await getActivePlans();
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

  // ── View Plans + Offers ───────────────────────────────────────────────────
  bot.action('view_plans_offers', async (ctx) => {
    await ctx.answerCbQuery();
    try {
      await User.findOneAndUpdate({ telegramId: ctx.from.id }, { lastInteraction: new Date() });

      const plans = await getActivePlans();
      const offers = await getActiveOffers();

      let message = `📋 *Plans ki Jankari*\n\n`;

      if (!plans.length) {
        message += `Plan check karne k liye supoort se contact karen /support type karen\n\n`;
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

      if (!offers.length) {
        return ctx.reply(
          `😔 *Koi active offers nahi hai abhi filhaal!*\n\n` +
          `New offer aane pe aapko notification mil jayega.`,
          { parse_mode: 'Markdown' }
        );
      }

      let message = `🎁 *Current Offers*\n\n`;
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
          ...supportCancelKeyboard(),
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

  const closeSupportChat = async (ctx) => {
    const userId = ctx.from.id;
    try {
      await User.findOneAndUpdate({ telegramId: userId }, { $unset: { 'meta.awaitingSupport': '' } });

      const ticket = await getActiveTicket(userId);
      if (!ticket) {
        return ctx.reply('ℹ️ Aapke paas koi open support chat nahi hai.');
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
