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
const Subscription = require('../models/Subscription');
const AdminLog = require('../models/AdminLog');
const UserOffer = require('../models/UserOffer');
const DmWordFilter = require('../models/DmWordFilter');
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
const { formatDate, daysRemaining, addDays, startOfToday } = require('../utils/dateUtils');
const { logToChannel } = require('../services/cronService');
const { generateInviteLink, isGroupMember, safeSend, banFromGroup, unbanFromGroup } = require('../utils/telegramUtils');
const { PLAN_CATEGORY, normalizePlanCategory, getGroupIdForCategory, getAllPremiumGroupIds } = require('../utils/premiumGroups');
const logger = require('../utils/logger');

const getSuperAdminIds = () => {
  return String(process.env.SUPER_ADMIN_IDS || process.env.SUPER_ADMIN_ID || '')
    .split(',')
    .map(id => parseInt(id.trim(), 10))
    .filter(Boolean);
};

const requireAdmin = async (ctx, next) => {
  const user = await User.findOne({ telegramId: ctx.from.id });
  if (!user || !['admin', 'superadmin'].includes(user.role)) {
    return ctx.reply('⛔ Access denied. Admins only.');
  }
  ctx.adminUser = user;
  return next();
};

const getSubscriptionGroupId = (subscription) => {
  if (subscription?.premiumGroupId) return String(subscription.premiumGroupId);
  return getGroupIdForCategory(subscription?.planCategory || subscription?.planId?.category || 'general');
};

const VALID_PLAN_CATEGORIES = new Set(Object.values(PLAN_CATEGORY));

const parseCategoryInput = (value) => {
  if (!value) return null;
  const normalized = String(value).toLowerCase().replace(/[-\s]/g, '_');
  if (!VALID_PLAN_CATEGORIES.has(normalized)) return null;
  return normalized;
};

const getActiveOrGraceSubscriptions = async (telegramId) => {
  return Subscription.find({
    telegramId,
    status: { $in: ['active', 'grace'] },
  }).sort({ expiryDate: -1, createdAt: -1 });
};

const resolveSubscriptionForAdminAction = async (telegramId, categoryInput = null) => {
  const subscriptions = await getActiveOrGraceSubscriptions(telegramId);
  if (!subscriptions.length) {
    return { error: 'none' };
  }

  const normalizedCategory = categoryInput ? parseCategoryInput(categoryInput) : null;
  if (categoryInput && !normalizedCategory) {
    return { error: 'invalid_category' };
  }

  if (normalizedCategory) {
    const matched = subscriptions.find(
      (sub) => normalizePlanCategory(sub.planCategory || sub.planId?.category || 'general') === normalizedCategory
    );
    if (!matched) {
      return { error: 'category_not_found', normalizedCategory, subscriptions };
    }
    return { subscription: matched, normalizedCategory, subscriptions };
  }

  if (subscriptions.length > 1) {
    return { error: 'ambiguous', subscriptions };
  }

  return {
    subscription: subscriptions[0],
    normalizedCategory: normalizePlanCategory(subscriptions[0].planCategory || subscriptions[0].planId?.category || 'general'),
    subscriptions,
  };
};

const formatSubscriptionCategoryList = (subscriptions) => {
  return subscriptions
    .map((sub) => {
      const category = normalizePlanCategory(sub.planCategory || sub.planId?.category || 'general');
      return `- ${category}: ${sub.planName} (expires ${formatDate(sub.expiryDate)})`;
    })
    .join('\n');
};

const normalizeFilterPhrase = (value) => String(value || '').trim().toLowerCase();

const parseFilterPhrase = (text = '', command = 'filter') => {
  const escapedCommand = String(command || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const raw = String(text || '').replace(new RegExp(`^\\/${escapedCommand}\\b`, 'i'), '').trim();
  if (!raw) return '';

  const quoted = raw.match(/^"([\s\S]+)"$/);
  if (quoted) return quoted[1].trim();
  return raw;
};

const extractFilterResponseFromReply = (replyMessage) => {
  if (!replyMessage) {
    return { error: 'missing_reply' };
  }

  if (replyMessage.sticker?.file_id) {
    return {
      responseType: 'sticker',
      responseStickerFileId: replyMessage.sticker.file_id,
      responseText: null,
      responsePhotoFileId: null,
      responseCaption: null,
    };
  }

  if (Array.isArray(replyMessage.photo) && replyMessage.photo.length > 0) {
    const bestPhoto = replyMessage.photo[replyMessage.photo.length - 1];
    return {
      responseType: 'photo',
      responsePhotoFileId: bestPhoto.file_id,
      responseCaption: String(replyMessage.caption || '').trim() || null,
      responseText: null,
      responseStickerFileId: null,
    };
  }

  const text = String(replyMessage.text || '').trim();
  if (text) {
    return {
      responseType: 'text',
      responseText: text,
      responsePhotoFileId: null,
      responseStickerFileId: null,
      responseCaption: null,
    };
  }

  return { error: 'unsupported_reply' };
};

const registerAdminHandlers = (bot) => {

  // ── /filter <phrase> — reply-based DM trigger/response mapping ────────────
  bot.command('filter', requireAdmin, async (ctx) => {
    if (ctx.chat?.type !== 'private') {
      return ctx.reply('❌ This command only works in DM/private chat.');
    }

    const phrase = parseFilterPhrase(ctx.message?.text || '');
    const normalizedPhrase = normalizeFilterPhrase(phrase);
    const responsePayload = extractFilterResponseFromReply(ctx.message?.reply_to_message);

    if (!normalizedPhrase) {
      return ctx.reply('Usage: reply to a message/photo/sticker with /filter "Any Word"');
    }

    if (responsePayload.error === 'missing_reply') {
      return ctx.reply('❌ Reply required. Reply to text/photo/sticker and send /filter "Any Word"');
    }

    if (responsePayload.error === 'unsupported_reply') {
      return ctx.reply('❌ Unsupported reply type. Use text/emoji, photo (with or without caption), or sticker.');
    }

    try {
      const existing = await DmWordFilter.findOne({ normalizedPhrase });
      let saved;

      if (existing) {
        existing.phrase = phrase;
        existing.createdBy = ctx.from.id;
        existing.responseType = responsePayload.responseType;
        existing.responseText = responsePayload.responseText;
        existing.responsePhotoFileId = responsePayload.responsePhotoFileId;
        existing.responseStickerFileId = responsePayload.responseStickerFileId;
        existing.responseCaption = responsePayload.responseCaption;
        saved = await existing.save();
      } else {
        saved = await DmWordFilter.create({
          phrase,
          normalizedPhrase,
          createdBy: ctx.from.id,
          ...responsePayload,
        });
      }

      await AdminLog.create({
        adminId: ctx.from.id,
        actionType: 'add_filter_word',
        details: {
          phrase: saved.phrase,
          responseType: saved.responseType,
          mode: existing ? 'updated' : 'created',
        },
      });

      await ctx.reply(
        `✅ DM filter ${existing ? 'updated' : 'added'}: "${saved.phrase}"\n` +
        `Response type: ${saved.responseType}`
      );
    } catch (err) {
      logger.error(`filter command error: ${err.message}`);
      await ctx.reply('❌ Failed to add filter. Please try again.');
    }
  });

  // ── /unfilter <phrase> — remove DM text filter phrase (admins + superadmins) ──
  bot.command('unfilter', requireAdmin, async (ctx) => {
    if (ctx.chat?.type !== 'private') {
      return ctx.reply('❌ This command only works in DM/private chat.');
    }

    const phrase = parseFilterPhrase(ctx.message?.text || '', 'unfilter');
    const normalizedPhrase = normalizeFilterPhrase(phrase);

    if (!normalizedPhrase) {
      return ctx.reply('Usage: /unfilter "Any Word"');
    }

    try {
      const removed = await DmWordFilter.findOneAndDelete({ normalizedPhrase });
      if (!removed) {
        return ctx.reply(`ℹ️ Filter not found: "${phrase}"`);
      }

      await AdminLog.create({
        adminId: ctx.from.id,
        actionType: 'remove_filter_word',
        details: { phrase: removed.phrase },
      });

      await ctx.reply(`✅ DM filter removed: "${removed.phrase}"`);
    } catch (err) {
      logger.error(`unfilter command error: ${err.message}`);
      await ctx.reply('❌ Failed to remove filter. Please try again.');
    }
  });

  // ── /filters — list all DM filters (admins + superadmins) ────────────────
  bot.command('filters', requireAdmin, async (ctx) => {
    if (ctx.chat?.type !== 'private') {
      return ctx.reply('❌ This command only works in DM/private chat.');
    }

    try {
      const filters = await DmWordFilter.find({})
        .select('phrase responseType createdAt')
        .sort({ createdAt: -1 })
        .lean();

      if (!filters.length) {
        return ctx.reply('ℹ️ No filters found.');
      }

      let msg = `🧩 *DM Filters* (${filters.length})\n\n`;
      filters.forEach((item, index) => {
        msg += `${index + 1}. "${item.phrase}" → *${item.responseType}*\n`;
      });

      msg += `\nRemove with: /unfilter "Any Word"`;
      await ctx.reply(msg, { parse_mode: 'Markdown' });
    } catch (err) {
      logger.error(`filters command error: ${err.message}`);
      await ctx.reply('❌ Failed to fetch filters. Please try again.');
    }
  });

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

      const requestCategory = normalizePlanCategory(request.requestCategory || 'general');

      // Resolve plan by _id or durationDays
      let plan = await Plan.findById(planOrDays).catch(() => null);
      if (!plan) {
        const days = parseInt(planOrDays);
        plan = await Plan.findOne({ durationDays: days, isActive: true, category: requestCategory });
        if (!plan) {
          plan = await Plan.create({ name: `${days} Days Plan`, durationDays: days, price: 0, category: requestCategory });
        }
      }

      const resolvedPlanCategory = normalizePlanCategory(plan.category || requestCategory);
      if (resolvedPlanCategory !== requestCategory) {
        return ctx.answerCbQuery('❌ Plan category mismatch for this request', { show_alert: true });
      }

      const premiumGroupId = getGroupIdForCategory(resolvedPlanCategory);
      if (!premiumGroupId) {
        return ctx.answerCbQuery('❌ Premium group not configured for this category', { show_alert: true });
      }

      const subscription = await createSubscription(request.telegramId, plan, ctx.from.id, {
        planCategory: resolvedPlanCategory,
        premiumGroupId,
      });
      await approveRequest(requestId, ctx.from.id, plan._id);

      // Check if user is already in the premium group (renewal case)
      const alreadyInGroup = await isGroupMember(bot, premiumGroupId, request.telegramId);

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
          bot, premiumGroupId, request.telegramId, subscription.expiryDate
        );

        if (inviteLink) {
          await Subscription.findByIdAndUpdate(subscription._id, {
            inviteLink,
            inviteLinkIssuedAt: new Date(),
            inviteLinkTtlMinutes: Math.max(1, parseInt(process.env.INVITE_LINK_TTL_MINUTES || '10', 10)),
          });
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
            inline_keyboard: [[{ text: '🔗 Join Premium Group', url: inviteLink, style: 'success' }]],
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
        `Category: ${resolvedPlanCategory}\n` +
        `Group: \`${premiumGroupId}\`\n` +
        `Plan: ${plan.name} (${plan.durationDays}d)\n` +
        `Expires: ${formatDate(subscription.expiryDate)}\n` +
        `By: ${ctx.from.username ? '@' + ctx.from.username : ctx.from.id}`
      );

      await AdminLog.create({
        adminId: ctx.from.id,
        actionType: 'approve_request',
        targetUserId: request.telegramId,
        details: {
          plan: plan.name,
          durationDays: plan.durationDays,
          category: resolvedPlanCategory,
          premiumGroupId,
          isRenewal: subscription.isRenewal,
        },
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

    const activeSubs = await Subscription.find({
      telegramId: targetId,
      status: { $in: ['active', 'grace'] },
      expiryDate: { $gt: new Date() },
    }).sort({ expiryDate: 1 });
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

    if (activeSubs.length) {
      msg += `\n📋 *Active/Grace Subscriptions:*\n`;
      activeSubs.forEach((sub, index) => {
        const category = normalizePlanCategory(sub.planCategory || sub.planId?.category || 'general');
        msg += `${index + 1}. *${category}* — ${sub.planName}\n`;
        msg += `   Status: ${sub.status}\n`;
        msg += `   Expires: ${formatDate(sub.expiryDate)} (Days left: *${daysRemaining(sub.expiryDate)}*)\n`;
      });
    } else {
      msg += `\n❌ No active subscription\n`;
    }

    if (user.referredBy) msg += `\n🤝 Referred by: \`${user.referredBy}\`\n`;

    await ctx.reply(msg, { parse_mode: 'Markdown' });
  });

  // ── /legacyadd <planIdOrDays>|<DD/MM/YYYY>|<id1,id2,...> ─────────────────
  bot.command('legacyadd', requireAdmin, async (ctx) => {
    try {
      if (!getSuperAdminIds().includes(ctx.from.id)) {
        return ctx.reply('⛔ Super Admin access required for /legacyadd.');
      }

      const raw = String(ctx.message?.text || '').replace('/legacyadd', '').trim();
      const [planPart, datePart, idsPart] = raw.split('|').map(s => s.trim());

      if (!planPart || !datePart || !idsPart) {
        return ctx.reply(
          'Usage: `/legacyadd <planIdOrDays>|<DD/MM/YYYY>|<id1,id2,id3,...>`',
          { parse_mode: 'Markdown' }
        );
      }

      let plan = await Plan.findById(planPart).catch(() => null);
      if (!plan) {
        const days = parseInt(planPart, 10);
        if (!days) {
          return ctx.reply('❌ Invalid plan value. Use planId or duration in days.');
        }
        plan = await Plan.findOne({ durationDays: days, isActive: true });
        if (!plan) {
          plan = await Plan.create({ name: `${days} Days Plan`, durationDays: days, price: 0 });
        }
      }

      const [d, m, y] = String(datePart).split('/').map(v => parseInt(v, 10));
      const expiryDate = new Date(y, (m || 1) - 1, d || 1, 23, 59, 59, 999);
      if (!d || !m || !y || Number.isNaN(expiryDate.getTime())) {
        return ctx.reply('❌ Invalid date format. Use DD/MM/YYYY.');
      }
      if (expiryDate <= new Date()) {
        return ctx.reply('❌ Expiry date must be in the future.');
      }

      const ids = [...new Set(
        idsPart
          .split(',')
          .map(s => parseInt(s.trim(), 10))
          .filter(Boolean)
      )];

      if (!ids.length) {
        return ctx.reply('❌ No valid user IDs found.');
      }

      if (ids.length > 200) {
        return ctx.reply('❌ Max 200 users per command. Please split into smaller batches.');
      }

      const startDate = new Date(expiryDate.getTime() - (plan.durationDays * 24 * 60 * 60 * 1000));
      const legacyCategory = normalizePlanCategory(plan.category || 'general');
      const legacyGroupId = getGroupIdForCategory(legacyCategory);
      if (!legacyGroupId) {
        return ctx.reply(`❌ Premium group not configured for category: ${legacyCategory}`);
      }

      let imported = 0;
      let updated = 0;
      let skippedNotInGroup = 0;
      let skippedInvalid = 0;
      const failedIds = [];

      for (const telegramId of ids) {
        try {
          const inGroup = await isGroupMember(bot, legacyGroupId, telegramId);
          if (!inGroup) {
            skippedNotInGroup++;
            continue;
          }

          let user = await User.findOne({ telegramId });
          if (!user) {
            user = await User.create({
              telegramId,
              name: `Legacy User ${telegramId}`,
              username: null,
              role: 'user',
              status: 'active',
            });
          }

          const existingSub = await Subscription.findOne({
            telegramId,
            status: { $in: ['active', 'grace'] },
          }).sort({ createdAt: -1 });

          if (existingSub) {
            existingSub.planId = plan._id;
            existingSub.planName = plan.name;
            existingSub.planCategory = legacyCategory;
            existingSub.premiumGroupId = legacyGroupId;
            existingSub.durationDays = plan.durationDays;
            existingSub.startDate = startDate;
            existingSub.expiryDate = expiryDate;
            existingSub.status = 'active';
            existingSub.approvedBy = ctx.from.id;
            existingSub.isRenewal = false;
            existingSub.graceDaysUsed = 0;
            existingSub.graceNotifications = { day1: false, day2: false, day3: false };
            existingSub.reminderFlags = { day7: false, day3: false, day1: false, day0: false };
            await existingSub.save();
            updated++;
          } else {
            await Subscription.create({
              userId: user._id,
              telegramId,
              planId: plan._id,
              planName: plan.name,
              planCategory: legacyCategory,
              premiumGroupId: legacyGroupId,
              durationDays: plan.durationDays,
              startDate,
              expiryDate,
              status: 'active',
              approvedBy: ctx.from.id,
              isRenewal: false,
            });
            imported++;
          }

          await User.findOneAndUpdate(
            { telegramId },
            { status: 'active', isBlocked: false, graceDaysRemaining: null, lastInteraction: new Date() }
          );
        } catch (e) {
          skippedInvalid++;
          failedIds.push(telegramId);
        }
      }

      await AdminLog.create({
        adminId: ctx.from.id,
        actionType: 'legacy_import',
        details: {
          plan: plan.name,
          durationDays: plan.durationDays,
          expiryDate,
          totalInput: ids.length,
          imported,
          updated,
          skippedNotInGroup,
          skippedInvalid,
          failedIds: failedIds.slice(0, 20),
        },
      });

      await ctx.reply(
        `✅ *Legacy Import Complete*\n\n` +
        `📥 Total IDs: *${ids.length}*\n` +
        `🆕 Imported: *${imported}*\n` +
        `♻️ Updated: *${updated}*\n` +
        `⛔ Not in group: *${skippedNotInGroup}*\n` +
        `⚠️ Failed: *${skippedInvalid}*\n\n` +
        `Plan: *${plan.name}* (${plan.durationDays} days)\n` +
        `Expiry: *${formatDate(expiryDate)}*`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      logger.error(`legacyadd command error: ${err.message}`);
      await ctx.reply('❌ Failed legacy import. Please check command format and try again.');
    }
  });

  // ── /revokeplan <telegramId> [category] — terminate specific plan ─────────
  bot.command('revokeplan', requireAdmin, async (ctx) => {
    try {
      const parts = String(ctx.message?.text || '').trim().split(/\s+/);
      if (parts.length < 2) {
        return ctx.reply('Usage: /revokeplan <telegramId> [movie|desi|non_desi|general]');
      }

      const targetId = parseInt(parts[1], 10);
      const categoryInput = parts[2] || null;
      if (!targetId) {
        return ctx.reply('❌ Invalid telegramId. Usage: /revokeplan <telegramId> [category]');
      }

      const targetUser = await User.findOne({ telegramId: targetId });
      if (!targetUser) {
        return ctx.reply(`❌ User \`${targetId}\` not found.`, { parse_mode: 'Markdown' });
      }

      const resolved = await resolveSubscriptionForAdminAction(targetId, categoryInput);
      if (resolved.error === 'none') {
        return ctx.reply('ℹ️ No active/grace subscription found for this user.');
      }
      if (resolved.error === 'invalid_category') {
        return ctx.reply('❌ Invalid category. Use movie, desi, non_desi, or general.');
      }
      if (resolved.error === 'category_not_found') {
        return ctx.reply(
          `❌ No active/grace subscription found in category *${resolved.normalizedCategory}*.`,
          { parse_mode: 'Markdown' }
        );
      }
      if (resolved.error === 'ambiguous') {
        return ctx.reply(
          `⚠️ Multiple active/grace subscriptions found. Please pass category.\n\n` +
          `Usage: /revokeplan <telegramId> [category]\n\n` +
          `${formatSubscriptionCategoryList(resolved.subscriptions)}`
        );
      }

      const activeSub = resolved.subscription;
      const resolvedCategory = normalizePlanCategory(activeSub.planCategory || activeSub.planId?.category || 'general');

      const revokedAt = new Date();
      activeSub.status = 'cancelled';
      activeSub.expiryDate = revokedAt;
      activeSub.graceDaysUsed = 0;
      activeSub.graceNotifications = { day1: false, day2: false, day3: false };
      await activeSub.save();

      const remainingActiveSubs = await Subscription.countDocuments({
        telegramId: targetId,
        status: { $in: ['active', 'grace'] },
      });

      await User.findOneAndUpdate(
        { telegramId: targetId },
        {
          status: remainingActiveSubs > 0 ? 'active' : 'inactive',
          graceDaysRemaining: null,
          lastInteraction: new Date(),
        }
      );

      const currentGroupId = getSubscriptionGroupId(activeSub);
      if (currentGroupId) {
        await banFromGroup(bot, currentGroupId, targetId);
        await unbanFromGroup(bot, currentGroupId, targetId);
      }

      await safeSend(
        bot,
        targetId,
        `⚠️ *Your subscription has been revoked by admin.*\n\n` +
        `Agar koi issue hai to support se contact karein: ${process.env.SUPPORT_CONTACT || '@ImaxSupport1Bot'}`,
        { parse_mode: 'Markdown' }
      );

      await AdminLog.create({
        adminId: ctx.from.id,
        actionType: 'manual_expire',
        targetUserId: targetId,
        details: {
          reason: 'Revoke incorrect approval',
          revokedSubscriptionId: activeSub._id,
          previousPlan: activeSub.planName,
          category: resolvedCategory,
        },
      });

      await ctx.reply(
        `✅ Plan revoked for user \`${targetId}\`.\nCategory: *${resolvedCategory}*\nPrevious plan: *${activeSub.planName}*\nUser removed from premium group.`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      logger.error(`revokeplan command error: ${err.message}`);
      await ctx.reply('❌ Failed to revoke plan. Please try again.');
    }
  });

  // ── /modifyplan <telegramId>|<planIdOrDays>|[category] — correct plan ───
  bot.command('modifyplan', requireAdmin, async (ctx) => {
    try {
      const raw = String(ctx.message?.text || '').replace('/modifyplan', '').trim();
      const [idPart, planPart, categoryPart] = raw.split('|').map(s => s.trim());

      if (!idPart || !planPart) {
        return ctx.reply('Usage: `/modifyplan <telegramId>|<planIdOrDays>|[movie|desi|non_desi|general]`', { parse_mode: 'Markdown' });
      }

      const targetId = parseInt(idPart, 10);
      if (!targetId) {
        return ctx.reply('❌ Invalid telegramId.');
      }

      const targetUser = await User.findOne({ telegramId: targetId });
      if (!targetUser) {
        return ctx.reply(`❌ User \`${targetId}\` not found.`, { parse_mode: 'Markdown' });
      }

      let plan = await Plan.findById(planPart).catch(() => null);
      if (!plan) {
        const days = parseInt(planPart, 10);
        if (!days) {
          return ctx.reply('❌ Invalid plan value. Use planId or duration in days.');
        }
        plan = await Plan.findOne({ durationDays: days, isActive: true });
      }

      if (!plan) {
        return ctx.reply('❌ Plan not found. Use `/plans` to see active plans.', { parse_mode: 'Markdown' });
      }

      const resolved = await resolveSubscriptionForAdminAction(targetId, categoryPart || null);
      if (resolved.error === 'none') {
        return ctx.reply('ℹ️ No active/grace subscription found for this user to modify.');
      }
      if (resolved.error === 'invalid_category') {
        return ctx.reply('❌ Invalid category. Use movie, desi, non_desi, or general.');
      }
      if (resolved.error === 'category_not_found') {
        return ctx.reply(
          `❌ No active/grace subscription found in category *${resolved.normalizedCategory}* for modify.`,
          { parse_mode: 'Markdown' }
        );
      }
      if (resolved.error === 'ambiguous') {
        return ctx.reply(
          `⚠️ Multiple active/grace subscriptions found. Please pass category in 3rd argument.\n\n` +
          `Usage: /modifyplan <telegramId>|<planIdOrDays>|[category]\n\n` +
          `${formatSubscriptionCategoryList(resolved.subscriptions)}`
        );
      }

      const activeSub = resolved.subscription;
      const oldGroupId = getSubscriptionGroupId(activeSub);

      const previousPlan = activeSub.planName;
      const now = new Date();
      const newExpiry = new Date(now.getTime() + (plan.durationDays * 24 * 60 * 60 * 1000));
      const newPlanCategory = normalizePlanCategory(plan.category || 'general');
      const newGroupId = getGroupIdForCategory(newPlanCategory);
      if (!newGroupId) {
        return ctx.reply(`❌ Premium group not configured for category: ${newPlanCategory}`);
      }

      activeSub.planId = plan._id;
      activeSub.planName = plan.name;
      activeSub.planCategory = newPlanCategory;
      activeSub.premiumGroupId = newGroupId;
      activeSub.durationDays = plan.durationDays;
      activeSub.startDate = now;
      activeSub.expiryDate = newExpiry;
      activeSub.status = 'active';
      activeSub.approvedBy = ctx.from.id;
      activeSub.isRenewal = false;
      activeSub.graceDaysUsed = 0;
      activeSub.graceNotifications = { day1: false, day2: false, day3: false };
      activeSub.reminderFlags = { day7: false, day3: false, day1: false, day0: false };
      await activeSub.save();

      await User.findOneAndUpdate(
        { telegramId: targetId },
        { status: 'active', graceDaysRemaining: null, lastInteraction: new Date() }
      );

      if (oldGroupId && String(oldGroupId) !== String(newGroupId)) {
        await banFromGroup(bot, oldGroupId, targetId);
        await unbanFromGroup(bot, oldGroupId, targetId);
      }

      const alreadyInGroup = await isGroupMember(bot, newGroupId, targetId);
      const extra = { parse_mode: 'Markdown' };
      let userMsg =
        `✅ *Your subscription plan has been updated by admin.*\n\n` +
        `📋 New Plan: *${plan.name}*\n` +
        `📅 Valid for: *${plan.durationDays} days*\n` +
        `⏰ Expires on: *${formatDate(newExpiry)}*`;

      if (!alreadyInGroup) {
        const inviteLink = await generateInviteLink(bot, newGroupId, targetId, newExpiry);
        if (inviteLink) {
          extra.reply_markup = {
            inline_keyboard: [[{ text: '🔗 Join Premium Group', url: inviteLink, style: 'success' }]],
          };
          userMsg += `\n\nGroup join karne ke liye niche button par click karein.`;
          await Subscription.findByIdAndUpdate(activeSub._id, {
            inviteLink,
            inviteLinkIssuedAt: new Date(),
            inviteLinkTtlMinutes: Math.max(1, parseInt(process.env.INVITE_LINK_TTL_MINUTES || '10', 10)),
          });
        }
      }

      await safeSend(bot, targetId, userMsg, extra);

      await AdminLog.create({
        adminId: ctx.from.id,
        actionType: 'edit_plan',
        targetUserId: targetId,
        details: {
          reason: 'Correct wrong selected plan',
          subscriptionId: activeSub._id,
          previousPlan,
          previousCategory: resolved.normalizedCategory,
          newPlan: plan.name,
          newCategory: newPlanCategory,
          newDurationDays: plan.durationDays,
        },
      });

      await ctx.reply(
        `✅ Plan updated for user \`${targetId}\`.\n*${previousPlan}* → *${plan.name}*\nCategory: *${newPlanCategory}*\nNew expiry: *${formatDate(newExpiry)}*`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      logger.error(`modifyplan command error: ${err.message}`);
      await ctx.reply('❌ Failed to modify plan. Please try again.');
    }
  });

  // ── /invite <telegramId> [category] — resend category-wise invite ─────────
  bot.command('invite', requireAdmin, async (ctx) => {
    try {
      const parts = String(ctx.message?.text || '').trim().split(/\s+/);
      if (parts.length < 2) {
        return ctx.reply('Usage: /invite <telegramId> [movie|desi|non_desi|general]');
      }

      const targetId = parseInt(parts[1], 10);
      const categoryInput = parts[2] || null;
      if (!targetId) {
        return ctx.reply('❌ Invalid telegramId. Usage: /invite <telegramId> [category]');
      }

      const targetUser = await User.findOne({ telegramId: targetId });
      if (!targetUser) {
        return ctx.reply(`❌ User \`${targetId}\` not found.`, { parse_mode: 'Markdown' });
      }

      // Nullify any previous pending request so user can raise a fresh one if needed.
      const pendingResult = await Request.updateMany(
        { telegramId: targetId, status: 'pending' },
        { status: 'rejected', actionDate: new Date(), actionBy: ctx.from.id }
      );

      const resolved = await resolveSubscriptionForAdminAction(targetId, categoryInput);
      if (resolved.error === 'invalid_category') {
        return ctx.reply('❌ Invalid category. Use movie, desi, non_desi, or general.');
      }
      if (resolved.error === 'category_not_found') {
        return ctx.reply(
          `❌ No active/grace subscription found in category *${resolved.normalizedCategory}* for invite.`,
          { parse_mode: 'Markdown' }
        );
      }
      if (resolved.error === 'ambiguous') {
        return ctx.reply(
          `⚠️ Multiple active/grace subscriptions found. Please pass category.\n\n` +
          `Usage: /invite <telegramId> [category]\n\n` +
          `${formatSubscriptionCategoryList(resolved.subscriptions)}`
        );
      }

      const activeSub = resolved.subscription;
      if (!activeSub || activeSub.expiryDate <= new Date()) {
        await User.findOneAndUpdate(
          { telegramId: targetId },
          { status: 'inactive', graceDaysRemaining: null, lastInteraction: new Date() }
        );

        await safeSend(
          bot,
          targetId,
          `ℹ️ *Please raise a new joining request.*\n\n` +
          `Aapka pehle ka pending request reset kar diya gaya hai.\n` +
          `Kripya /start karke *Premium Access Request* dubara bhejein.`,
          { parse_mode: 'Markdown' }
        );

        await AdminLog.create({
          adminId: ctx.from.id,
          actionType: 'resend_invite',
          targetUserId: targetId,
          details: {
            result: 'no_active_subscription',
            nullifiedPendingRequests: pendingResult?.modifiedCount || 0,
          },
        });

        return ctx.reply(
          `✅ Pending request(s) reset for \`${targetId}\`.\nNo active subscription found, user asked to raise a new request.`,
          { parse_mode: 'Markdown' }
        );
      }

      const inviteGroupId = getSubscriptionGroupId(activeSub);
      if (!inviteGroupId) {
        return ctx.reply('❌ Premium group mapping missing for this user subscription.');
      }

      const inviteLink = await generateInviteLink(bot, inviteGroupId, targetId, activeSub.expiryDate);
      if (!inviteLink) {
        return ctx.reply('❌ Failed to generate a new invite link. Check bot group admin permissions.');
      }

      await Subscription.findByIdAndUpdate(activeSub._id, {
        inviteLink,
        inviteLinkIssuedAt: new Date(),
        inviteLinkTtlMinutes: Math.max(1, parseInt(process.env.INVITE_LINK_TTL_MINUTES || '10', 10)),
      });

      await safeSend(
        bot,
        targetId,
        `🔗 *New Invite Link Generated*\n\n` +
        `Aapka naya joining link ready hai. Niche button pe click karke group join karein.\n\n` +
        `⏰ Link limited-time aur single-use hai.`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[{ text: '🔗 Join Premium Group', url: inviteLink, style: 'success' }]],
          },
        }
      );

      await AdminLog.create({
        adminId: ctx.from.id,
        actionType: 'resend_invite',
        targetUserId: targetId,
        details: {
          subscriptionId: activeSub._id,
          category: normalizePlanCategory(activeSub.planCategory || activeSub.planId?.category || 'general'),
          plan: activeSub.planName,
          expiryDate: activeSub.expiryDate,
          nullifiedPendingRequests: pendingResult?.modifiedCount || 0,
        },
      });

      const now = new Date();
      await logToChannel(
        bot,
        `✅ *New Invite Link issued:*\n` +
        `For User Id: \`${targetId}\`\n` +
        `By Admin Id: \`${ctx.from.id}\`\n` +
        `Date: ${now.toLocaleDateString('en-GB')}\n` +
        `Time: ${now.toLocaleTimeString('en-IN')}`
      );

      await ctx.reply(
        `✅ New invite link sent to user \`${targetId}\`.\nCategory: *${normalizePlanCategory(activeSub.planCategory || activeSub.planId?.category || 'general')}*\nPlan: *${activeSub.planName}*\nExpires: *${formatDate(activeSub.expiryDate)}*`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      logger.error(`invite command error: ${err.message}`);
      await ctx.reply('❌ Failed to resend invite. Please try again.');
    }
  });

  // ── /offeruser <id>|<discount> ────────────────────────────────────────────
  bot.command('offeruser', requireAdmin, async (ctx) => {
    try {
      const raw = String(ctx.message?.text || '').replace('/offeruser', '').trim();
      const [idPart, discountPart] = raw.split('|').map(s => s.trim());

      if (!idPart || !discountPart) {
        return ctx.reply(
          'Usage: `/offeruser <telegramId>|<discountPercent>`',
          { parse_mode: 'Markdown' }
        );
      }

      const targetId = parseInt(idPart, 10);
      if (!targetId) {
        return ctx.reply('❌ Invalid telegramId.');
      }

      const targetUser = await User.findOne({ telegramId: targetId });
      if (!targetUser) {
        return ctx.reply(`❌ User \`${targetId}\` not found.`, { parse_mode: 'Markdown' });
      }

      const discount = parseInt(discountPart, 10);
      if (Number.isNaN(discount) || discount < 0 || discount > 100) {
        return ctx.reply('❌ discountPercent must be between 0 and 100.');
      }

      const validTill = new Date();
      validTill.setHours(23, 59, 59, 999);

      const defaultTitle = 'Special Discount';
      const defaultDescription = 'Only for you!';

      const offer = await UserOffer.create({
        targetTelegramId: targetId,
        title: defaultTitle,
        description: defaultDescription,
        discountPercent: discount,
        validTill,
        createdBy: ctx.from.id,
      });

      await AdminLog.create({
        adminId: ctx.from.id,
        actionType: 'create_offer',
        targetUserId: targetId,
        details: {
          userOfferId: offer._id,
          userSpecific: true,
          title: offer.title,
          discountPercent: offer.discountPercent,
          validTill: offer.validTill,
        },
      });

      await safeSend(
        bot,
        targetId,
        `🎁 *Private Offer Received!*\n\n` +
        `*Special Discount*\n` +
        `Only for you!\n` +
        `${offer.discountPercent > 0 ? `💰 Discount: *${offer.discountPercent}%*\n` : ''}` +
        `⏰ Valid till: *Today only*\n\n` +
        `Ye offer sirf aapke liye hai aur next request/renewal par ek hi baar apply hoga.`,
        { parse_mode: 'Markdown' }
      );

      await ctx.reply(
        `✅ One-time private offer created for \`${targetId}\`.\nOffer ID: \`${offer._id}\``,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      logger.error(`offeruser command error: ${err.message}`);
      await ctx.reply('❌ Failed to create private offer. Please check format and try again.');
    }
  });

  // ── /ban <telegramId> — block user from using bot ─────────────────────────
  bot.command('ban', requireAdmin, async (ctx) => {
    try {
      const parts = String(ctx.message?.text || '').trim().split(/\s+/);
      if (parts.length < 2) {
        return ctx.reply('Usage: /ban <telegramId>');
      }

      const targetId = parseInt(parts[1], 10);
      if (!targetId) {
        return ctx.reply('❌ Invalid telegramId. Usage: /ban <telegramId>');
      }

      if (targetId === ctx.from.id) {
        return ctx.reply('❌ You cannot ban yourself.');
      }

      const targetUser = await User.findOne({ telegramId: targetId });
      if (!targetUser) {
        return ctx.reply(`❌ User \`${targetId}\` not found.`, { parse_mode: 'Markdown' });
      }

      if (['admin', 'superadmin'].includes(targetUser.role)) {
        return ctx.reply('⛔ You cannot ban an admin/superadmin user.');
      }

      await User.findOneAndUpdate(
        { telegramId: targetId },
        { isBlocked: true, status: 'blocked', lastInteraction: new Date() }
      );

      const groupIds = getAllPremiumGroupIds();
      for (const groupId of groupIds) {
        await banFromGroup(bot, groupId, targetId);
      }

      await safeSend(
        bot,
        targetId,
        `⛔ *You have been banned from using this bot.*\n\n` +
        `Please contact support for this issue: ${process.env.SUPPORT_CONTACT || '@ImaxSupport1Bot'}`,
        { parse_mode: 'Markdown' }
      );

      await AdminLog.create({
        adminId: ctx.from.id,
        actionType: 'ban_user',
        targetUserId: targetId,
        details: { reason: 'Manual ban via /ban command' },
      });

      await ctx.reply(`✅ User \`${targetId}\` has been banned from bot usage.`, { parse_mode: 'Markdown' });
    } catch (err) {
      logger.error(`ban command error: ${err.message}`);
      await ctx.reply('❌ Failed to ban user. Please try again.');
    }
  });

  // ── /unban <telegramId> — restore user bot access ────────────────────────
  bot.command('unban', requireAdmin, async (ctx) => {
    try {
      const parts = String(ctx.message?.text || '').trim().split(/\s+/);
      if (parts.length < 2) {
        return ctx.reply('Usage: /unban <telegramId>');
      }

      const targetId = parseInt(parts[1], 10);
      if (!targetId) {
        return ctx.reply('❌ Invalid telegramId. Usage: /unban <telegramId>');
      }

      const targetUser = await User.findOne({ telegramId: targetId });
      if (!targetUser) {
        return ctx.reply(`❌ User \`${targetId}\` not found.`, { parse_mode: 'Markdown' });
      }

      await User.findOneAndUpdate(
        { telegramId: targetId },
        { isBlocked: false, status: 'active', lastInteraction: new Date() }
      );

      const groupIds = getAllPremiumGroupIds();
      for (const groupId of groupIds) {
        await unbanFromGroup(bot, groupId, targetId);
      }

      await safeSend(
        bot,
        targetId,
        `✅ *Your access has been restored.*\n\nYou can now use the bot again.`,
        { parse_mode: 'Markdown' }
      );

      await AdminLog.create({
        adminId: ctx.from.id,
        actionType: 'unban_user',
        targetUserId: targetId,
        details: { reason: 'Manual unban via /unban command' },
      });

      await ctx.reply(`✅ User \`${targetId}\` has been unbanned.`, { parse_mode: 'Markdown' });
    } catch (err) {
      logger.error(`unban command error: ${err.message}`);
      await ctx.reply('❌ Failed to unban user. Please try again.');
    }
  });

  // ── /expiries [today|0|1|3|7] — check upcoming expiries ──────────────────
  bot.command('expiries', requireAdmin, async (ctx) => {
    try {
      const arg = (String(ctx.message?.text || '').trim().split(/\s+/)[1] || '').toLowerCase();

      let checkpoints = [0, 1, 3, 7];
      if (arg) {
        if (arg === 'today') {
          checkpoints = [0];
        } else {
          const days = parseInt(arg, 10);
          if (![0, 1, 3, 7].includes(days)) {
            return ctx.reply('Usage: `/expiries [today|0|1|3|7]`', { parse_mode: 'Markdown' });
          }
          checkpoints = [days];
        }
      }

      let message = '⏰ *Expiry Check*\n\n';
      const today = startOfToday();

      for (const days of checkpoints) {
        const targetStart = addDays(today, days);
        const targetEnd = new Date(targetStart);
        targetEnd.setHours(23, 59, 59, 999);

        const subs = await Subscription.find({
          status: 'active',
          expiryDate: { $gte: targetStart, $lte: targetEnd },
        }).sort({ expiryDate: 1 }).limit(50);

        const label = days === 0 ? 'Today' : `In ${days} day${days > 1 ? 's' : ''}`;
        message += `*${label}:* ${subs.length}\n`;

        if (subs.length) {
          subs.forEach((sub, index) => {
            message += `${index + 1}. \`${sub.telegramId}\` — ${sub.planName} — ${formatDate(sub.expiryDate)}\n`;
          });
        }

        message += '\n';
      }

      if (message.length > 3900) {
        message = message.slice(0, 3900) + '\n...truncated';
      }

      await ctx.reply(message, { parse_mode: 'Markdown' });
    } catch (err) {
      logger.error(`expiries command error: ${err.message}`);
      await ctx.reply('❌ Failed to fetch expiry list. Please try again.');
    }
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
