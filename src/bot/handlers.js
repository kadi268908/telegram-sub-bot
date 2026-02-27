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
  getTodayTicketCount,
  SUPPORT_CONTACT,
} = require('../services/supportService');
const { processReferral } = require('../services/referralService');
const { safeSend, renewalKeyboard, isGroupMember } = require('../utils/telegramUtils');
const { formatDate, daysRemaining } = require('../utils/dateUtils');
const logger = require('../utils/logger');

const REJOINING_PENALTY = process.env.REJOINING_PENALTY || '20';

// ── Helpers ──────────────────────────────────────────────────────────────────

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
        plans.slice(i, i + 2).map(p => ({
          text: `${p.name} (${p.durationDays}d${p.price ? ` · ₹${p.price}` : ''})`,
          callback_data: `approve_${requestId}_${p._id}`,
        }))
      );
    }
    planButtons = rows;
  } else {
    planButtons = [[
      { text: '30 Days', callback_data: `approve_${requestId}_30` },
      { text: '90 Days', callback_data: `approve_${requestId}_90` },
      { text: '180 Days', callback_data: `approve_${requestId}_180` },
      { text: '365 Days', callback_data: `approve_${requestId}_365` },
    ]];
  }

  return {
    inline_keyboard: [
      ...planButtons,
      [{ text: '❌ Reject', callback_data: `reject_${requestId}` }],
    ],
  };
};

// ── Register handlers ─────────────────────────────────────────────────────────

const registerUserHandlers = (bot) => {

  // ── /start ─────────────────────────────────────────────────────────────────
  bot.start(async (ctx) => {
    try {
      const user = await findOrCreateUser(ctx.from);
      await User.findByIdAndUpdate(user._id, { lastInteraction: new Date() });

      // Referral: /start ref_XXXXXXXX
      const payload = ctx.startPayload;
      if (payload && payload.startsWith('ref_')) {
        await processReferral(user, payload.replace('ref_', ''));
      }

      const isNew = new Date() - user.createdAt < 10000;

      await ctx.reply(
        `${isNew ? '👋 Welcome' : '👋 Welcome back'}, *${user.name}*!\n\n` +
        `I manage access to the *Premium Group*.\n` +
        `Choose an option below to get started:`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🌟 Request Premium Access', 'request_access')],
            [Markup.button.callback('📊 My Subscription Status', 'check_status')],
            [Markup.button.callback('🎁 View Current Offers', 'view_offers')],
            [Markup.button.callback('🤝 My Referral Link', 'my_referral')],
            [Markup.button.callback('🎫 Contact Support', 'open_support')],
          ]),
        }
      );
    } catch (err) {
      logger.error(`/start error: ${err.message}`);
      await ctx.reply('❌ Something went wrong. Please try again.');
    }
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
          `✅ *You already have an active subscription!*\n\n` +
          `📋 Plan: *${activeSub.planName}*\n` +
          `📅 Expires: *${formatDate(activeSub.expiryDate)}*`,
          { parse_mode: 'Markdown' }
        );
      }

      const pendingReq = await getPendingRequest(ctx.from.id);
      if (pendingReq) {
        return ctx.reply(
          `⏳ *Request Already Submitted*\n\n` +
          `Your request is currently under review.\n` +
          `Please wait — you'll be notified once an admin approves it.`,
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
        `✅ *Request Submitted Successfully!*\n\n` +
        `Our admin team has been notified.\n` +
        `You will receive your access details here as soon as it's approved.\n\n` +
        `⏱ Usually approved within a few minutes.`,
        { parse_mode: 'Markdown' }
      );

      const keyboard = await buildApprovalKeyboard(newRequest._id);
      const logMsg = await bot.telegram.sendMessage(
        process.env.LOG_CHANNEL_ID,
        `🆕 *New Premium Access Request*\n\n` +
        `👤 Name: ${user.name}\n` +
        `🆔 User ID: \`${ctx.from.id}\`\n` +
        `📛 Username: ${user.username ? '@' + user.username : 'N/A'}\n` +
        `🕒 Time: ${new Date().toLocaleString('en-IN')}`,
        { parse_mode: 'Markdown', reply_markup: keyboard }
      );

      await Request.findByIdAndUpdate(newRequest._id, { logMessageId: logMsg.message_id });
      logger.info(`New access request: user ${ctx.from.id}`);
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
          `⏳ *Renewal Already Pending*\n\n` +
          `You already have a pending renewal request.\n` +
          `Please wait for admin approval.`,
          { parse_mode: 'Markdown' }
        );
      }

      const renewalReq = await Request.create({
        userId: user._id,
        telegramId: ctx.from.id,
        status: 'pending',
      });

      await ctx.reply(
        `🔄 *Renewal Request Submitted!*\n\n` +
        `📋 Plan: *${plan.name}* (${plan.durationDays} days${plan.price ? ` · ₹${plan.price}` : ''})\n\n` +
        `You'll be notified once approved.`,
        { parse_mode: 'Markdown' }
      );

      const logMsg = await bot.telegram.sendMessage(
        process.env.LOG_CHANNEL_ID,
        `🔄 *Renewal Request*\n\n` +
        `👤 Name: ${user.name}\n` +
        `🆔 ID: \`${ctx.from.id}\`\n` +
        `📛 Username: ${user.username ? '@' + user.username : 'N/A'}\n` +
        `📋 Plan: ${plan.name} (${plan.durationDays} days${plan.price ? ` · ₹${plan.price}` : ''})`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[
              { text: `✅ Approve`, callback_data: `approve_${renewalReq._id}_${plan._id}` },
              { text: '❌ Reject', callback_data: `reject_${renewalReq._id}` },
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
          ? `\n⚠️ *You are not in the Premium Group!*\n` +
            `A rejoining penalty of *₹${REJOINING_PENALTY}* applies.\n` +
            `Please contact support using /support.\n`
          : '';

        return ctx.reply(
          `📊 *Your Subscription*\n\n` +
          `✅ Status: *Active*\n` +
          `📋 Plan: *${activeSub.planName}*\n` +
          `📅 Expires on: *${formatDate(activeSub.expiryDate)}*\n` +
          `⏳ Days Remaining: *${remaining} days*\n` +
          groupWarning +
          (plans.length ? `\n💡 Want to extend? Choose a plan below:` : ''),
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
          `⏳ *${left} grace day(s) remaining* before you are removed from the group.\n\n` +
          `Renew now to keep your access:`,
          {
            parse_mode: 'Markdown',
            reply_markup: plans.length ? renewalKeyboard(plans) : undefined,
          }
        );
      }

      await ctx.reply(
        `❌ *No Active Subscription*\n\n` +
        `You don't currently have an active subscription.\n` +
        `Tap below to request access:`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🌟 Request Access', 'request_access')],
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

  // ── View Offers ────────────────────────────────────────────────────────────
  bot.action('view_offers', async (ctx) => {
    await ctx.answerCbQuery();
    try {
      await User.findOneAndUpdate({ telegramId: ctx.from.id }, { lastInteraction: new Date() });
      const offers = await getActiveOffers();

      if (!offers.length) {
        return ctx.reply(
          `😔 *No Active Offers Right Now*\n\n` +
          `Check back soon — we regularly add new deals!`,
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
  //      Already used today's ticket? → redirect to SUPPORT_CONTACT
  //      First time today? → create topic + let them type
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
          `💬 *Support Chat Already Open*\n\n` +
          `Ticket: \`${existing.ticketId}\`\n\n` +
          `Just send your message here — our team will reply shortly.\n\n` +
          `📌 Send /cancel if you want to close this support chat.`,
          { parse_mode: 'Markdown' }
        );
      }

      // Case 2: Daily limit reached → redirect
      const todayCount = await getTodayTicketCount(userId);
      if (todayCount >= 1) {
        return ctx.reply(
          `⚠️ *Daily Support Limit Reached*\n\n` +
          `You can only open *1 support chat per day* through this bot.\n\n` +
          `For additional help, please contact us directly:\n` +
          `👉 ${SUPPORT_CONTACT}`,
          { parse_mode: 'Markdown' }
        );
      }

      // Case 3: First ticket today → prompt for message
      // We set a flag in User doc so next message creates the ticket
      await User.findOneAndUpdate({ telegramId: userId }, { $set: { 'meta.awaitingSupport': true } });

      await ctx.reply(
        `🎫 *Contact Support*\n\n` +
        `Hi ${user.name}! 👋\n\n` +
        `Just type your question or issue below and send it.\n` +
        `Our support team will reply here in your chat.\n\n` +
        `━━━━━━━━━━━━━━━━\n` +
        `📌 *Tips for faster help:*\n` +
        `• Describe your issue clearly\n` +
        `• Include your User ID if asked: \`${userId}\`\n` +
        `• One message is fine — add details after\n` +
        `━━━━━━━━━━━━━━━━\n\n` +
        `Send /cancel to cancel.`,
        { parse_mode: 'Markdown' }
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

  // ── /cancel — user closes their support chat ──────────────────────────────
  bot.command('cancel', async (ctx) => {
    const userId = ctx.from.id;
    try {
      // Clear awaiting flag
      await User.findOneAndUpdate({ telegramId: userId }, { $unset: { 'meta.awaitingSupport': '' } });

      const ticket = await getActiveTicket(userId);
      if (!ticket) {
        return ctx.reply('ℹ️ You have no open support chat to cancel.');
      }

      await closeTicket(bot, ticket.topicId, null, true);
      // closeTicket already sends the DM to the user
    } catch (err) {
      logger.error(`/cancel error: ${err.message}`);
      await ctx.reply('❌ Error closing chat. Please try again.');
    }
  });

  // ── Text handler: intercept user messages for active support chats ─────────
  bot.on('text', async (ctx, next) => {
    // Only process private messages (not group messages)
    if (ctx.chat.type !== 'private') return next();

    const userId = ctx.from.id;
    const text = ctx.message.text;

    // Skip commands
    if (text.startsWith('/')) return next();

    await User.findOneAndUpdate({ telegramId: userId }, { lastInteraction: new Date() }).catch(() => {});

    try {
      const user = await findOrCreateUser(ctx.from);

      // Check if user is awaiting support (about to create ticket)
      const userDoc = await User.findOne({ telegramId: userId });
      const isAwaiting = userDoc?.meta?.awaitingSupport === true;

      // Check if user already has an open ticket
      const activeTicket = await getActiveTicket(userId);

      if (!isAwaiting && !activeTicket) {
        // Not in any support flow — pass to next handler
        return next();
      }

      if (isAwaiting && !activeTicket) {
        // First message — create the ticket and topic
        await User.findOneAndUpdate({ telegramId: userId }, { $unset: { 'meta.awaitingSupport': '' } });

        let ticket;
        try {
          ticket = await openTicket(bot, user, text);
        } catch (err) {
          if (err.code === 'DAILY_LIMIT_REACHED') {
            return ctx.reply(
              `⚠️ *Daily Limit Reached*\n\n` +
              `You can only open 1 support chat per day.\n` +
              `Contact: ${SUPPORT_CONTACT}`,
              { parse_mode: 'Markdown' }
            );
          }
          throw err;
        }

        await ctx.reply(
          `✅ *Support Chat Connected!*\n\n` +
          `Ticket ID: \`${ticket.ticketId}\`\n\n` +
          `Our team has been notified and will reply to you here.\n` +
          `You can keep sending messages — they all go to the same chat.\n\n` +
          `📌 Send /cancel to close this support chat anytime.`,
          { parse_mode: 'Markdown' }
        );

      } else if (activeTicket) {
        // Follow-up message — forward to existing topic
        if (isAwaiting) {
          await User.findOneAndUpdate({ telegramId: userId }, { $unset: { 'meta.awaitingSupport': '' } });
        }
        await forwardUserMessage(bot, activeTicket, user, text);
        // Small confirmation tick so user knows message was delivered
        await ctx.react('👍').catch(() => {}); // reaction if supported, else silent
      }

    } catch (err) {
      logger.error(`support text handler error: ${err.message}`);
      await ctx.reply('❌ Error sending message. Please try again.');
    }
  });
};

module.exports = { registerUserHandlers };
