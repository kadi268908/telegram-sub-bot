// src/bot/superAdminHandlers.js
// Super admin: plan/offer/admin management, broadcast, reports, stats, planstats

const User = require('../models/User');
const Plan = require('../models/Plan');
const Subscription = require('../models/Subscription');
const Request = require('../models/Request');
const AdminLog = require('../models/AdminLog');
const {
  addAdmin, removeAdmin, createPlan, updatePlan, deletePlan,
  getAllPlans, getActivePlans, createOffer, deleteOffer, getActiveOffers
} = require('../services/adminService');
const { getSalesReport, getTodayExpiryList } = require('../services/subscriptionService');
const { getGrowthStats, getPlanPerformance } = require('../services/analyticsService');
const {
  getPendingSellerWithdrawalRequests,
  approveSellerWithdrawal,
  rejectSellerWithdrawal,
} = require('../services/referralService');
const { logToChannel } = require('../services/cronService');
const { safeSend } = require('../utils/telegramUtils');
const { formatDate, startOfToday, endOfToday, startOfWeek, startOfMonth } = require('../utils/dateUtils');
const logger = require('../utils/logger');

// In-memory session for broadcast flow
const sessions = {};

const getSuperAdminIds = () => {
  return String(process.env.SUPER_ADMIN_IDS || process.env.SUPER_ADMIN_ID || '')
    .split(',')
    .map(id => parseInt(id.trim(), 10))
    .filter(Boolean);
};

const requireSuperAdmin = async (ctx, next) => {
  const superAdminIds = getSuperAdminIds();
  if (!superAdminIds.includes(ctx.from.id)) {
    return ctx.reply('⛔ Super Admin access required.');
  }
  return next();
};

const registerSuperAdminHandlers = (bot) => {

  const isSuperAdminUser = (telegramId) => {
    const superAdminIds = getSuperAdminIds();
    return superAdminIds.includes(telegramId);
  };

  // ── Admin management ───────────────────────────────────────────────────────
  bot.command('addadmin', requireSuperAdmin, async (ctx) => {
    const id = parseInt(ctx.message.text.split(' ')[1]);
    if (!id) return ctx.reply('Usage: /addadmin <telegramId>');
    try {
      const user = await addAdmin(id);
      await AdminLog.create({ adminId: ctx.from.id, actionType: 'add_admin', targetUserId: id, details: {} });
      await logToChannel(bot, `👑 Admin Added: \`${id}\` (@${user.username || 'N/A'})`);
      await ctx.reply(`✅ *${user.name}* is now an Admin.`, { parse_mode: 'Markdown' });
    } catch (err) { await ctx.reply(`❌ ${err.message}`); }
  });

  bot.command('removeadmin', requireSuperAdmin, async (ctx) => {
    const id = parseInt(ctx.message.text.split(' ')[1]);
    if (!id) return ctx.reply('Usage: /removeadmin <telegramId>');
    try {
      const user = await removeAdmin(id);
      await AdminLog.create({ adminId: ctx.from.id, actionType: 'remove_admin', targetUserId: id, details: {} });
      await ctx.reply(`✅ *${user.name}* is no longer an Admin.`, { parse_mode: 'Markdown' });
    } catch (err) { await ctx.reply(`❌ ${err.message}`); }
  });

  bot.command('admins', requireSuperAdmin, async (ctx) => {
    const admins = await User.find({ role: 'admin' });
    if (!admins.length) return ctx.reply('No admins found.');
    let msg = '👑 *Admin List*\n\n';
    admins.forEach((a, i) => {
      msg += `${i + 1}. ${a.name} — \`${a.telegramId}\`${a.username ? ' (@' + a.username + ')' : ''}\n`;
    });
    await ctx.reply(msg, { parse_mode: 'Markdown' });
  });

  // ── Plan management ────────────────────────────────────────────────────────
  // /createplan Name|days|price
  bot.command('createplan', requireSuperAdmin, async (ctx) => {
    const text = ctx.message.text.replace('/createplan', '').trim();
    const [name, days, price] = text.split('|').map(s => s.trim());
    if (!name || !days) return ctx.reply('Usage: `/createplan Name|days|price`', { parse_mode: 'Markdown' });
    try {
      const plan = await createPlan({ name, durationDays: parseInt(days), price: price ? parseFloat(price) : 0 });
      await AdminLog.create({ adminId: ctx.from.id, actionType: 'create_plan', details: { planId: plan._id, name } });
      await ctx.reply(`✅ Plan created: *${plan.name}* (${plan.durationDays} days)\nID: \`${plan._id}\``, { parse_mode: 'Markdown' });
    } catch (err) { await ctx.reply(`❌ ${err.message}`); }
  });

  // /editplan id|field|value
  bot.command('editplan', requireSuperAdmin, async (ctx) => {
    const text = ctx.message.text.replace('/editplan', '').trim();
    const [planId, field, value] = text.split('|').map(s => s.trim());
    if (!planId || !field || !value) return ctx.reply('Usage: `/editplan id|field|value`', { parse_mode: 'Markdown' });
    try {
      const updates = { [field]: isNaN(value) ? value : parseFloat(value) };
      const plan = await updatePlan(planId, updates);
      await AdminLog.create({ adminId: ctx.from.id, actionType: 'edit_plan', details: { planId, field, value } });
      await ctx.reply(`✅ Plan *${plan.name}* updated.`, { parse_mode: 'Markdown' });
    } catch (err) { await ctx.reply(`❌ ${err.message}`); }
  });

  bot.command('deleteplan', requireSuperAdmin, async (ctx) => {
    const planId = ctx.message.text.split(' ')[1];
    if (!planId) return ctx.reply('Usage: /deleteplan <planId>');
    try {
      await deletePlan(planId);
      await AdminLog.create({ adminId: ctx.from.id, actionType: 'delete_plan', details: { planId } });
      await ctx.reply('✅ Plan deleted.');
    } catch (err) { await ctx.reply(`❌ ${err.message}`); }
  });

  bot.command('pauseplan', requireSuperAdmin, async (ctx) => {
    const planId = ctx.message.text.split(' ')[1];
    if (!planId) return ctx.reply('Usage: /pauseplan <planId>');
    try {
      const plan = await Plan.findByIdAndUpdate(planId, [{ $set: { isActive: { $not: '$isActive' } } }], { new: true });
      await ctx.reply(`✅ Plan *${plan.name}* is now ${plan.isActive ? '✅ Active' : '⏸ Paused'}.`, { parse_mode: 'Markdown' });
    } catch (err) { await ctx.reply(`❌ ${err.message}`); }
  });

  bot.command('listplans', requireSuperAdmin, async (ctx) => {
    const plans = await getAllPlans();
    if (!plans.length) return ctx.reply('No plans found.');
    let msg = '📋 *All Plans*\n\n';
    plans.forEach((p, i) => {
      msg += `${i + 1}. *${p.name}* — ${p.durationDays} days — ₹${p.price} — ${p.isActive ? '✅' : '⏸'}\n   \`${p._id}\`\n`;
    });
    await ctx.reply(msg, { parse_mode: 'Markdown' });
  });

  // ── Offer management ───────────────────────────────────────────────────────
  // /addoffer Title|Desc|DD/MM/YYYY|discount%
  bot.command('addoffer', requireSuperAdmin, async (ctx) => {
    const text = ctx.message.text.replace('/addoffer', '').trim();
    const [title, description, dateStr, discount] = text.split('|').map(s => s.trim());
    if (!title || !description || !dateStr) {
      return ctx.reply('Usage: `/addoffer Title|Description|DD/MM/YYYY|discountPercent`', { parse_mode: 'Markdown' });
    }
    try {
      const [d, m, y] = dateStr.split('/');
      const offer = await createOffer({
        title, description,
        validTill: new Date(`${y}-${m}-${d}`),
        discountPercent: discount ? parseInt(discount) : 0,
        createdBy: ctx.from.id,
      });
      await AdminLog.create({ adminId: ctx.from.id, actionType: 'create_offer', details: { offerId: offer._id, title } });
      await ctx.reply(`✅ Offer created: *${offer.title}*`, { parse_mode: 'Markdown' });
    } catch (err) { await ctx.reply(`❌ ${err.message}`); }
  });

  bot.command('deleteoffer', requireSuperAdmin, async (ctx) => {
    const offerId = ctx.message.text.split(' ')[1];
    if (!offerId) return ctx.reply('Usage: /deleteoffer <offerId>');
    try {
      await deleteOffer(offerId);
      await ctx.reply('✅ Offer deleted.');
    } catch (err) { await ctx.reply(`❌ ${err.message}`); }
  });

  bot.command('listoffers', requireSuperAdmin, async (ctx) => {
    const offers = await getActiveOffers();
    if (!offers.length) return ctx.reply('No active offers.');
    let msg = '🎁 *Active Offers*\n\n';
    offers.forEach((o, i) => {
      msg += `${i + 1}. *${o.title}*\n${o.description}\nValid till: ${formatDate(o.validTill)}\n\`${o._id}\`\n\n`;
    });
    await ctx.reply(msg, { parse_mode: 'Markdown' });
  });

  // ── /broadcast ─────────────────────────────────────────────────────────────
  bot.command('broadcast', requireSuperAdmin, async (ctx) => {
    await ctx.reply('📢 *Broadcast — Choose Target:*', {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '👥 All Users', callback_data: 'bc_all' }, { text: '✅ Active', callback_data: 'bc_active' }],
          [{ text: '❌ Expired', callback_data: 'bc_expired' }, { text: '🆕 New (last 3 days)', callback_data: 'bc_new' }],
        ],
      },
    });
  });

  bot.action(/^bc_(all|active|expired|new)$/, requireSuperAdmin, async (ctx) => {
    await ctx.answerCbQuery();
    sessions[ctx.from.id] = { action: 'broadcast', target: ctx.match[1] };
    await ctx.reply(`📝 Type your broadcast message for *${ctx.match[1]}* users.\nSend /cancel to abort.`, { parse_mode: 'Markdown' });
  });

  // ── /reports ───────────────────────────────────────────────────────────────
  bot.command('reports', requireSuperAdmin, async (ctx) => {
    await ctx.reply('📊 *Reports — Choose Type:*', {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '📅 Daily Sales', callback_data: 'report_daily' }, { text: '📆 Weekly', callback_data: 'report_weekly' }],
          [{ text: '🗓 Monthly', callback_data: 'report_monthly' }, { text: '📋 Today Expiry', callback_data: 'report_expiry' }],
          [{ text: '✅ Active Users', callback_data: 'report_active' }, { text: '❌ Expired Users', callback_data: 'report_expired' }],
        ],
      },
    });
  });

  bot.action(/^report_(daily|weekly|monthly|expiry|active|expired)$/, requireSuperAdmin, async (ctx) => {
    await ctx.answerCbQuery('Generating...');
    const type = ctx.match[1];
    try {
      let message = '';
      if (type === 'daily') {
        message = formatSalesReport('📅 Daily Sales', await getSalesReport(startOfToday(), endOfToday()));
      } else if (type === 'weekly') {
        message = formatSalesReport('📆 Weekly Sales', await getSalesReport(startOfWeek(), new Date()));
      } else if (type === 'monthly') {
        message = formatSalesReport('🗓 Monthly Sales', await getSalesReport(startOfMonth(), new Date()));
      } else if (type === 'expiry') {
        const list = await getTodayExpiryList();
        message = `📋 *Today's Expiry List* (${list.length})\n\n`;
        list.forEach((s, i) => { message += `${i + 1}. \`${s.telegramId}\` — ${s.planName}\n`; });
        if (!list.length) message += 'No expirations today.';
      } else if (type === 'active') {
        const c = await Subscription.countDocuments({ status: 'active', expiryDate: { $gt: new Date() } });
        message = `✅ *Active Subscriptions:* ${c}`;
      } else if (type === 'expired') {
        const c = await Subscription.countDocuments({ status: 'expired' });
        message = `❌ *Total Expired:* ${c}`;
      }
      await ctx.reply(message, { parse_mode: 'Markdown' });
    } catch (err) {
      await ctx.reply('❌ Error generating report.');
      logger.error(`report error: ${err.message}`);
    }
  });

  // ── /report <Nd|Nm> — custom CSV report (e.g. 1d, 7d, 28d, 1m) ─────────
  bot.command('report', requireSuperAdmin, async (ctx) => {
    try {
      const token = (ctx.message.text.split(' ')[1] || '').trim().toLowerCase();
      const parsed = parseReportDuration(token);
      if (!parsed) {
        return ctx.reply('Usage: `/report <Nd|Nm>`\nExamples: `/report 1d`, `/report 7d`, `/report 28d`, `/report 1m`', { parse_mode: 'Markdown' });
      }

      const { value, unit } = parsed;
      const endDate = new Date();
      const startDate = new Date(endDate);
      if (unit === 'd') startDate.setDate(startDate.getDate() - value);
      else startDate.setMonth(startDate.getMonth() - value);

      const [
        requestsReceived,
        approvals,
        rejections,
        subsCreated,
        renewals,
        newUsers,
        activeNow,
        expiredNow,
        blockedNow,
        salesByPlan,
        subscriptionRows,
      ] = await Promise.all([
        Request.countDocuments({ createdAt: { $gte: startDate, $lte: endDate } }),
        Request.countDocuments({ status: 'approved', actionDate: { $gte: startDate, $lte: endDate } }),
        Request.countDocuments({ status: 'rejected', actionDate: { $gte: startDate, $lte: endDate } }),
        Subscription.countDocuments({ createdAt: { $gte: startDate, $lte: endDate } }),
        Subscription.countDocuments({
          createdAt: { $gte: startDate, $lte: endDate },
          isRenewal: true,
        }),
        User.countDocuments({ createdAt: { $gte: startDate, $lte: endDate } }),
        Subscription.countDocuments({ status: 'active', expiryDate: { $gt: endDate } }),
        Subscription.countDocuments({ status: 'expired' }),
        User.countDocuments({ isBlocked: true }),
        getSalesReport(startDate, endDate),
        Subscription.find({
          createdAt: { $gte: startDate, $lte: endDate },
        })
          .select('telegramId planName startDate expiryDate approvedBy status')
          .sort({ createdAt: -1 })
          .lean(),
      ]);

      const label = `${value}${unit}`;
      const generatedAt = new Date();
      const rows = [
        ['Section', 'Metric', 'Value'],
        ['Meta', 'Range', label],
        ['Meta', 'StartDate', startDate.toISOString()],
        ['Meta', 'EndDate', endDate.toISOString()],
        ['Meta', 'GeneratedAt', generatedAt.toISOString()],
        ['Summary', 'RequestsReceived', requestsReceived],
        ['Summary', 'Approvals', approvals],
        ['Summary', 'Rejections', rejections],
        ['Summary', 'SubscriptionsCreated', subsCreated],
        ['Summary', 'Renewals', renewals],
        ['Summary', 'NewUsers', newUsers],
        ['Snapshot', 'ActiveSubscriptionsNow', activeNow],
        ['Snapshot', 'ExpiredSubscriptionsNow', expiredNow],
        ['Snapshot', 'BlockedUsersNow', blockedNow],
      ];

      rows.push([]);
      rows.push(['PlanSales', 'PlanName', 'Count', 'Revenue']);
      if (salesByPlan.length) {
        salesByPlan.forEach((row) => {
          rows.push(['PlanSales', row.planName, row.count, Number(row.totalRevenue || 0).toFixed(2)]);
        });
      } else {
        rows.push(['PlanSales', 'NoData', 0, '0.00']);
      }

      rows.push([]);
      rows.push(['UserSubscriptions', 'UserID', 'Plan', 'StartDate', 'ExpiryDate', 'ApprovedByAdminId', 'Status']);
      if (subscriptionRows.length) {
        subscriptionRows.forEach((sub) => {
          rows.push([
            'UserSubscriptions',
            sub.telegramId,
            sub.planName,
            sub.startDate ? new Date(sub.startDate).toISOString() : '',
            sub.expiryDate ? new Date(sub.expiryDate).toISOString() : '',
            sub.approvedBy ?? '',
            sub.status || '',
          ]);
        });
      } else {
        rows.push(['UserSubscriptions', 'NoData', '', '', '', '', '']);
      }

      const csv = rows.map(toCsvRow).join('\n');
      const fileName = `report_${label}_${generatedAt.toISOString().slice(0, 10)}.csv`;

      await ctx.replyWithDocument(
        {
          source: Buffer.from(csv, 'utf8'),
          filename: fileName,
        },
        {
          caption: `📄 CSV report generated for ${label}`,
        }
      );
    } catch (err) {
      logger.error(`custom report csv error: ${err.message}`);
      await ctx.reply('❌ Failed to generate CSV report.');
    }
  });

  // ── /stats — growth dashboard ──────────────────────────────────────────────
  bot.command('stats', requireSuperAdmin, async (ctx) => {
    try {
      const s = await getGrowthStats();
      await ctx.reply(
        `📈 *Growth Dashboard*\n\n` +
        `👥 Total Users: *${s.total}*\n` +
        `✅ Active: *${s.active}*\n` +
        `❌ Expired: *${s.expired}*\n` +
        `🚫 Blocked: *${s.blocked}*\n` +
        `🆕 New Today: *${s.newToday}*\n` +
        `🔄 Renewals Today: *${s.renewalsToday}*`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      await ctx.reply('❌ Error fetching stats.');
    }
  });

  // ── /planstats — plan performance ─────────────────────────────────────────
  bot.command('planstats', requireSuperAdmin, async (ctx) => {
    try {
      const data = await getPlanPerformance();
      if (!data.length) return ctx.reply('No active subscriptions found.');

      let msg = '📊 *Plan Performance*\n\n';
      data.forEach(row => {
        msg += `📋 *${row.planName}* (${row.durationDays} days): *${row.count}* active users\n`;
      });
      await ctx.reply(msg, { parse_mode: 'Markdown' });
    } catch (err) {
      await ctx.reply('❌ Error fetching plan stats.');
    }
  });

  // ── Seller withdrawal management ──────────────────────────────────────────
  bot.command('sellerwithdrawals', requireSuperAdmin, async (ctx) => {
    const items = await getPendingSellerWithdrawalRequests(20);
    if (!items.length) return ctx.reply('✅ No pending seller withdrawals.');

    let msg = '💸 *Pending Seller Withdrawals*\n\n';
    items.forEach((item, i) => {
      msg += `${i + 1}. ID: \`${item._id}\`\n`;
      msg += `   Seller: \`${item.sellerTelegramId}\`\n`;
      msg += `   Amount: *₹${Number(item.amount).toFixed(2)}*\n`;
      msg += `   Requested: ${new Date(item.requestedAt).toLocaleString('en-IN')}\n\n`;
    });

    msg += 'Approve: `/approvesellerwd <requestId>`\n';
    msg += 'Reject: `/rejectsellerwd <requestId> | reason`';
    await ctx.reply(msg, { parse_mode: 'Markdown' });
  });

  bot.command('approvesellerwd', requireSuperAdmin, async (ctx) => {
    const requestId = (ctx.message.text.split(' ')[1] || '').trim();
    if (!requestId) return ctx.reply('Usage: /approvesellerwd <requestId>');

    try {
      const request = await approveSellerWithdrawal(requestId, ctx.from.id);
      await safeSend(
        bot,
        request.sellerTelegramId,
        `✅ *Seller Withdrawal Approved*\n\n` +
        `Request ID: \`${request._id}\`\n` +
        `Amount: *₹${Number(request.amount).toFixed(2)}*\n\n` +
        `Payout will be processed shortly.`,
        { parse_mode: 'Markdown' }
      );

      await ctx.reply(`✅ Approved withdrawal \`${request._id}\` for ₹${Number(request.amount).toFixed(2)}.`, { parse_mode: 'Markdown' });
    } catch (err) {
      await ctx.reply(`❌ ${err.message}`);
    }
  });

  bot.command('rejectsellerwd', requireSuperAdmin, async (ctx) => {
    const raw = ctx.message.text.replace('/rejectsellerwd', '').trim();
    const [requestIdPart, ...rest] = raw.split('|');
    const requestId = (requestIdPart || '').trim();
    const reason = rest.join('|').trim();

    if (!requestId) return ctx.reply('Usage: /rejectsellerwd <requestId> | reason');

    try {
      const request = await rejectSellerWithdrawal(requestId, ctx.from.id, reason);
      await safeSend(
        bot,
        request.sellerTelegramId,
        `❌ *Seller Withdrawal Rejected*\n\n` +
        `Request ID: \`${request._id}\`\n` +
        `Amount: *₹${Number(request.amount).toFixed(2)}*\n` +
        `${request.note ? `Reason: ${request.note}\n` : ''}`,
        { parse_mode: 'Markdown' }
      );

      await ctx.reply(`✅ Rejected withdrawal \`${request._id}\`.`, { parse_mode: 'Markdown' });
    } catch (err) {
      await ctx.reply(`❌ ${err.message}`);
    }
  });

  bot.action(/^swd_(approve|reject)_(.+)$/, async (ctx) => {
    const action = ctx.match[1];
    const requestId = ctx.match[2];

    if (!isSuperAdminUser(ctx.from.id)) {
      return ctx.answerCbQuery('⛔ Super Admin only', { show_alert: true });
    }

    await ctx.answerCbQuery(action === 'approve' ? 'Approving...' : 'Rejecting...');

    try {
      let request;
      if (action === 'approve') {
        request = await approveSellerWithdrawal(requestId, ctx.from.id);
        await safeSend(
          bot,
          request.sellerTelegramId,
          `✅ *Seller Withdrawal Approved*\n\n` +
          `Request ID: \`${request._id}\`\n` +
          `Amount: *₹${Number(request.amount).toFixed(2)}*\n\n` +
          `Payout will be processed shortly.`,
          { parse_mode: 'Markdown' }
        );
      } else {
        request = await rejectSellerWithdrawal(requestId, ctx.from.id, 'Rejected from inline action');
        await safeSend(
          bot,
          request.sellerTelegramId,
          `❌ *Seller Withdrawal Rejected*\n\n` +
          `Request ID: \`${request._id}\`\n` +
          `Amount: *₹${Number(request.amount).toFixed(2)}*\n` +
          `Reason: ${request.note}`,
          { parse_mode: 'Markdown' }
        );
      }

      try {
        await ctx.editMessageText(
          `${ctx.callbackQuery.message.text}\n\n` +
          `${action === 'approve' ? '✅ *APPROVED*' : '❌ *REJECTED*'} by ${ctx.from.username ? '@' + ctx.from.username : ctx.from.id}`,
          { parse_mode: 'Markdown' }
        );
      } catch (_) { }
    } catch (err) {
      await ctx.answerCbQuery(`❌ ${err.message}`, { show_alert: true });
    }
  });

  // ── /adminlogs — recent admin activity ────────────────────────────────────
  bot.command('adminlogs', requireSuperAdmin, async (ctx) => {
    const logs = await AdminLog.find({}).sort({ timestamp: -1 }).limit(15);
    if (!logs.length) return ctx.reply('No admin logs found.');
    let msg = '📋 *Recent Admin Actions*\n\n';
    logs.forEach(l => {
      msg += `• \`${l.actionType}\` by \`${l.adminId}\``;
      if (l.targetUserId) msg += ` → \`${l.targetUserId}\``;
      msg += `\n  ${new Date(l.timestamp).toLocaleString('en-GB')}\n`;
    });
    await ctx.reply(msg, { parse_mode: 'Markdown' });
  });

  // ── /cancel ────────────────────────────────────────────────────────────────
  bot.command('cancel', requireSuperAdmin, async (ctx) => {
    if (sessions[ctx.from.id]) {
      delete sessions[ctx.from.id];
      await ctx.reply('✅ Cancelled.');
    }
  });

  // ── Text handler: broadcast message capture ───────────────────────────────
  bot.on('text', async (ctx, next) => {
    const session = sessions[ctx.from.id];
    if (!session || session.action !== 'broadcast') return next();
    delete sessions[ctx.from.id];

    const { target } = session;
    const message = ctx.message.text;

    let filter = { role: 'user', isBlocked: false };
    if (target === 'active') filter.status = 'active';
    else if (target === 'expired') filter.status = 'expired';
    else if (target === 'new') {
      const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
      filter.createdAt = { $gte: threeDaysAgo };
    }

    const users = await User.find(filter);
    await ctx.reply(`📤 Sending to *${users.length}* users...`, { parse_mode: 'Markdown' });

    let sent = 0, failed = 0;
    for (const user of users) {
      const ok = await safeSend(bot, user.telegramId, message);
      ok ? sent++ : failed++;
      await new Promise(r => setTimeout(r, 50)); // rate limit throttle
    }

    const summary = `📢 *Broadcast Complete*\n✅ Sent: ${sent}\n❌ Failed: ${failed}\nTarget: ${target}`;
    await ctx.reply(summary, { parse_mode: 'Markdown' });
    await logToChannel(bot, summary);

    await AdminLog.create({
      adminId: ctx.from.id,
      actionType: 'broadcast',
      details: { target, sent, failed, message: message.substring(0, 100) },
    });
  });
};

const formatSalesReport = (title, data) => {
  if (!data.length) return `${title}\n\nNo data found.`;
  let msg = `*${title}*\n\n`;
  let totalSubs = 0, totalRevenue = 0;
  data.forEach(r => {
    msg += `📋 *${r.planName}*: ${r.count} subs — ₹${r.totalRevenue.toFixed(2)}\n`;
    totalSubs += r.count;
    totalRevenue += r.totalRevenue;
  });
  msg += `\n📊 Total: ${totalSubs} — ₹${totalRevenue.toFixed(2)}`;
  return msg;
};

const parseReportDuration = (token) => {
  const match = String(token || '').match(/^(\d+)([dm])$/i);
  if (!match) return null;

  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  if (!value || value <= 0) return null;
  if (unit === 'd' && value > 365) return null;
  if (unit === 'm' && value > 24) return null;
  return { value, unit };
};

const toCsvCell = (value) => {
  const raw = value === null || typeof value === 'undefined' ? '' : String(value);
  if (/[",\n]/.test(raw)) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
};

const toCsvRow = (columns) => {
  return columns.map(toCsvCell).join(',');
};

module.exports = { registerSuperAdminHandlers };
