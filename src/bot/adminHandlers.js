// src/bot/adminHandlers.js
// Admin handlers:
//   • approve/reject access requests (inline buttons in log channel)
//   • /user <id> — full user profile
//   • /plans, /tickets — admin utilities
//   • Support topic relay: messages admins type IN the forum topic
//     are automatically forwarded to the user's DM
//   • close_topic_<topicId> button — closes and archives the ticket

const User = require('../models/User');
const Request = require('../models/Request');
const Plan = require('../models/Plan');
const AdminLog = require('../models/AdminLog');
const { createSubscription } = require('../services/subscriptionService');
const { approveRequest, rejectRequest, getActivePlans } = require('../services/adminService');
const { awardReferralBonus, awardSellerCommission } = require('../services/referralService');
const {
  forwardAdminReply,
  closeTicket,
  getTicketByTopicId,
  getOpenTickets,
  SUPPORT_GROUP_ID,
} = require('../services/supportService');
const { formatDate, daysRemaining } = require('../utils/dateUtils');
const { logToChannel } = require('../services/cronService');
const { generateInviteLink, isGroupMember, safeSend } = require('../utils/telegramUtils');
const logger = require('../utils/logger');

const requireAdmin = async (ctx, next) => {
  const user = await User.findOne({ telegramId: ctx.from.id });
  if (!user || !['admin', 'superadmin'].includes(user.role)) {
    return ctx.reply('⛔ Access denied. Admins only.');
  }
  ctx.adminUser = user;
  return next();
};

const registerAdminHandlers = (bot) => {

  // ── SUPPORT: Forward admin topic replies to user DM ────────────────────────
  // When an admin types a message inside a support forum topic,
  // this handler picks it up and forwards it to the user's DM.
  bot.on('message', async (ctx, next) => {
    // Only process messages from the support group
    if (!SUPPORT_GROUP_ID) return next();
    if (String(ctx.chat?.id) !== String(SUPPORT_GROUP_ID)) return next();

    // Must be a topic (thread) message
    const threadId = ctx.message?.message_thread_id;
    if (!threadId) return next();

    // Skip bot's own messages
    if (ctx.from?.is_bot) return next();

    // Skip commands
    const text = ctx.message?.text || ctx.message?.caption;
    if (!text || text.startsWith('/')) return next();

    try {
      // Find which ticket this topic belongs to
      const ticket = await getTicketByTopicId(threadId);
      if (!ticket || ticket.status === 'closed') return next();

      // Verify the sender is an admin
      const adminUser = await User.findOne({ telegramId: ctx.from.id });
      if (!adminUser || !['admin', 'superadmin'].includes(adminUser.role)) return next();

      const adminName = adminUser.username ? `@${adminUser.username}` : adminUser.name;

      // Forward the reply to user's DM
      await forwardAdminReply(bot, ticket, adminName, text);

      // React with a checkmark in the topic to confirm delivery
      await ctx.react('✅').catch(() => { });

      logger.info(`Admin ${ctx.from.id} replied to ticket ${ticket.ticketId} → user ${ticket.telegramId}`);
    } catch (err) {
      logger.error(`support topic relay error: ${err.message}`);
    }
  });

  // ── SUPPORT: Close topic button ────────────────────────────────────────────
  // Admin presses "✅ Close Ticket" inside the forum topic
  bot.action(/^close_topic_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery('Closing ticket...');
    try {
      const adminUser = await User.findOne({ telegramId: ctx.from.id });
      if (!adminUser || !['admin', 'superadmin'].includes(adminUser.role)) {
        return ctx.answerCbQuery('⛔ Admins only', { show_alert: true });
      }

      const topicId = parseInt(ctx.match[1]);
      const ticket = await closeTicket(bot, topicId, ctx.from.id, false);

      if (!ticket) {
        return ctx.answerCbQuery('ℹ️ Ticket already closed', { show_alert: true });
      }

      // Edit the pinned message in the topic to show closed
      try {
        await ctx.editMessageText(
          ctx.callbackQuery.message.text +
          `\n\n✅ *CLOSED* by ${ctx.from.username ? '@' + ctx.from.username : ctx.from.id}\n` +
          `🕒 ${new Date().toLocaleString('en-IN')}`,
          { parse_mode: 'Markdown' }
        );
      } catch (_) { }

      logger.info(`Ticket ${ticket.ticketId} closed by admin ${ctx.from.id}`);
    } catch (err) {
      logger.error(`close_topic error: ${err.message}`);
    }
  });

  // ── Approve subscription request ───────────────────────────────────────────
  // callback_data: approve_<requestId>_<planId|days>
  bot.action(/^approve_(.+)_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery('Processing...');
    try {
      const [, requestId, planOrDays] = ctx.match;

      const adminUser = await User.findOne({ telegramId: ctx.from.id });
      if (!adminUser || !['admin', 'superadmin'].includes(adminUser.role)) {
        return ctx.answerCbQuery('⛔ Admins only', { show_alert: true });
      }

      const request = await Request.findById(requestId);
      if (!request) return ctx.answerCbQuery('❌ Request not found', { show_alert: true });
      if (request.status !== 'pending') {
        return ctx.answerCbQuery('ℹ️ Already processed', { show_alert: true });
      }

      // Resolve plan by _id or durationDays
      let plan = await Plan.findById(planOrDays).catch(() => null);
      if (!plan) {
        const days = parseInt(planOrDays);
        plan = await Plan.findOne({ durationDays: days, isActive: true });
        if (!plan) {
          plan = await Plan.create({ name: `${days} Days Plan`, durationDays: days, price: 0 });
        }
      }

      const subscription = await createSubscription(request.telegramId, plan, ctx.from.id);
      await approveRequest(requestId, ctx.from.id, plan._id);

      // Check if user is already in the premium group (renewal case)
      const alreadyInGroup = await isGroupMember(bot, process.env.PREMIUM_GROUP_ID, request.telegramId);

      let userMessage;
      const extra = { parse_mode: 'Markdown' };
      if (subscription.isRenewal && alreadyInGroup) {
        // Renewal — user stays in group, no invite needed
        userMessage =
          `🎉 *Subscription Renewed!*\n\n` +
          `📋 Plan: *${plan.name}*\n` +
          `➕ Extended by: *${plan.durationDays} days*\n` +
          `📅 New Expiry: *${formatDate(subscription.expiryDate)}*\n\n` +
          `Apka premium renew ho gaya hai. \n\n` +
          `Thank you! 🙏`;
      } else {
        // New subscription or user left group — generate invite link
        const inviteLink = await generateInviteLink(
          bot, process.env.PREMIUM_GROUP_ID, request.telegramId, subscription.expiryDate
        );

        if (inviteLink) {
          const Subscription = require('../models/Subscription');
          await Subscription.findByIdAndUpdate(subscription._id, { inviteLink });
        }

        userMessage =
          `🎉 *Access Approved!*\n\n` +
          `📋 Plan: *${plan.name}*\n` +
          `📅 Valid for: *${plan.durationDays} days*\n` +
          `⏰ Expires on: *${formatDate(subscription.expiryDate)}*\n\n` +
          (inviteLink
            ? `🔗 *Premium Group join kijiye niche diye gai button pe click karke*\n\n` +
            `⚠️ Yeh single-use link hai. Kripya iss link ko share na kare nahi to aap ban ho shakte hain.\n\n`
            : '') +
          `Thank you for joining! 🙏\n\n` +
          `📌 Iss bot ko block nahi kijiyega nahi to aage aane waale offers miss ho jayenge.`;

        // Send invite as a button instead of plain text URL
        if (inviteLink) {
          extra.reply_markup = {
            inline_keyboard: [[{ text: '🔗 Join Premium Group', url: inviteLink }]],
          };
        }
      }

      await safeSend(bot, request.telegramId, userMessage, extra);
      await awardReferralBonus(bot, request.telegramId);
      await awardSellerCommission(bot, request.telegramId, plan.price || 0);

      // Edit log channel message
      try {
        await ctx.editMessageText(
          ctx.callbackQuery.message.text +
          `\n\n✅ *APPROVED* by ${ctx.from.username ? '@' + ctx.from.username : ctx.from.id}` +
          ` — ${plan.name}` +
          (subscription.isRenewal ? ' [RENEWAL]' : ''),
          { parse_mode: 'Markdown' }
        );
      } catch (_) { }

      await logToChannel(bot,
        `✅ *Subscription ${subscription.isRenewal ? 'Renewed' : 'Approved'}*\n` +
        `User: \`${request.telegramId}\`\n` +
        `Plan: ${plan.name} (${plan.durationDays}d)\n` +
        `Expires: ${formatDate(subscription.expiryDate)}\n` +
        `By: ${ctx.from.username ? '@' + ctx.from.username : ctx.from.id}`
      );

      await AdminLog.create({
        adminId: ctx.from.id,
        actionType: 'approve_request',
        targetUserId: request.telegramId,
        details: { plan: plan.name, durationDays: plan.durationDays, isRenewal: subscription.isRenewal },
      });

    } catch (err) {
      logger.error(`approve error: ${err.message}`);
      await ctx.answerCbQuery('❌ Error processing', { show_alert: true });
    }
  });

  // ── Reject request ─────────────────────────────────────────────────────────
  bot.action(/^reject_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery('Rejecting...');
    try {
      const [, requestId] = ctx.match;
      const adminUser = await User.findOne({ telegramId: ctx.from.id });
      if (!adminUser || !['admin', 'superadmin'].includes(adminUser.role)) return;

      const request = await Request.findById(requestId);
      if (!request || request.status !== 'pending') return;

      await rejectRequest(requestId, ctx.from.id);

      await safeSend(bot, request.telegramId,
        `❌ *Request Not Approved*\n\n` +
        `Aaoka request reject kar diya gaya hai.\n\n` +
        `Agar koi galti hui hai to krpiya support team se contact karein. /support \n\n`,
        { parse_mode: 'Markdown' }
      );

      try {
        await ctx.editMessageText(
          ctx.callbackQuery.message.text +
          `\n\n❌ *REJECTED* by ${ctx.from.username ? '@' + ctx.from.username : ctx.from.id}`,
          { parse_mode: 'Markdown' }
        );
      } catch (_) { }

      await logToChannel(bot,
        `❌ *Request Rejected*\nUser: \`${request.telegramId}\`\n` +
        `By: ${ctx.from.username ? '@' + ctx.from.username : ctx.from.id}`
      );

      await AdminLog.create({
        adminId: ctx.from.id,
        actionType: 'reject_request',
        targetUserId: request.telegramId,
        details: {},
      });
    } catch (err) {
      logger.error(`reject error: ${err.message}`);
    }
  });

  // ── /user <telegramId> — user search panel ─────────────────────────────────
  bot.command('user', requireAdmin, async (ctx) => {
    const parts = ctx.message.text.split(' ');
    if (parts.length < 2) return ctx.reply('Usage: /user <telegramId>');

    const targetId = parseInt(parts[1]);
    const user = await User.findOne({ telegramId: targetId });
    if (!user) return ctx.reply(`❌ User \`${targetId}\` not found.`, { parse_mode: 'Markdown' });

    const Subscription = require('../models/Subscription');
    const activeSub = await Subscription.findOne({
      telegramId: targetId, status: 'active', expiryDate: { $gt: new Date() },
    });
    const totalSubs = await Subscription.countDocuments({ telegramId: targetId });

    let msg = `👤 *User Profile*\n\n`;
    msg += `Name: *${user.name}*\n`;
    msg += `Username: ${user.username ? '@' + user.username : 'N/A'}\n`;
    msg += `Telegram ID: \`${user.telegramId}\`\n`;
    msg += `Status: *${user.status}*\n`;
    msg += `Role: ${user.role}\n`;
    msg += `Joined: ${formatDate(user.joinDate)}\n`;
    msg += `Blocked: ${user.isBlocked ? '🚫 Yes' : '✅ No'}\n`;
    msg += `Total Subscriptions: *${totalSubs}*\n`;

    if (activeSub) {
      msg += `\n📋 *Active Plan:* ${activeSub.planName}\n`;
      msg += `⏰ Expires: ${formatDate(activeSub.expiryDate)}\n`;
      msg += `⏳ Days Left: *${daysRemaining(activeSub.expiryDate)}*\n`;
    } else {
      msg += `\n❌ No active subscription\n`;
    }

    if (user.referredBy) msg += `\n🤝 Referred by: \`${user.referredBy}\`\n`;

    await ctx.reply(msg, { parse_mode: 'Markdown' });
  });

  // ── /plans ─────────────────────────────────────────────────────────────────
  bot.command('plans', requireAdmin, async (ctx) => {
    const plans = await getActivePlans();
    if (!plans.length) return ctx.reply('No active plans. Use /createplan to add one.');
    let msg = '📋 *Active Plans*\n\n';
    plans.forEach((p, i) => {
      msg += `${i + 1}. *${p.name}* — ${p.durationDays} days${p.price ? ` — ₹${p.price}` : ''}\n   ID: \`${p._id}\`\n`;
    });
    await ctx.reply(msg, { parse_mode: 'Markdown' });
  });

  // ── /tickets — list open support tickets ───────────────────────────────────
  bot.command('tickets', requireAdmin, async (ctx) => {
    const tickets = await getOpenTickets(10);
    if (!tickets.length) return ctx.reply('✅ No open support tickets!');

    let msg = '🎫 *Open Support Tickets*\n\n';
    tickets.forEach(t => {
      msg += `*${t.ticketId}* — \`${t.telegramId}\`\n`;
      msg += `${t.firstMessage.substring(0, 60)}${t.firstMessage.length > 60 ? '...' : ''}\n\n`;
    });

    if (SUPPORT_GROUP_ID) {
      msg += `💡 Reply directly in the support group topic threads.`;
    }

    await ctx.reply(msg, { parse_mode: 'Markdown' });
  });
};

module.exports = { registerAdminHandlers, requireAdmin };
