# Telegram Subscription Management Bot v2.0

Production-ready Telegram bot with advanced subscription management, referrals, support tickets, grace periods, and analytics.

---

## New in v2.0

| Feature | Description |
|---|---|
| Smart Reminders | Alerts at 7, 3, 1 day before expiry + expiry day |
| One-Click Renewal | Inline renewal buttons in every reminder |
| Grace Period | 3-day window after expiry with daily warnings before ban |
| Referral System | Unique codes, bonus days for referrer on first sub |
| Anti-Link Protection | Invite links: 1 use, 10-minute expiry |
| Membership Monitor | Daily check: resend invites / remove expired users |
| Block Detection | 403 errors update user status + log to channel |
| Growth Dashboard | /stats — total/active/expired/blocked/new/renewals |
| Plan Performance | /planstats — active users per plan |
| Daily Auto-Summary | Posted to log channel every night at 23:59 |
| User Search Panel | /user <id> — full profile for admins |
| Support Tickets | /support → admin panel with reply/close flow |
| Inactive Re-engagement | Auto-DM users inactive 30+ days |
| Offer Countdown | Shows days remaining on each offer |
| Admin Audit Log | Every admin action stored in AdminLog |

---

## Quick Start

```bash
git clone <repo>
cd telegram-subscription-bot
npm install
cp .env.example .env   # fill in your values
npm start
```

### Bot Permissions Required

**Premium Group** — add bot as Admin with:
- Ban users
- Invite users via link

**Log Channel** — add bot as Admin with:
- Post messages

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `BOT_TOKEN` | ✅ | From @BotFather |
| `MONGO_URI` | ✅ | MongoDB connection string |
| `PREMIUM_GROUP_ID` | ✅ | Group ID (negative number) |
| `LOG_CHANNEL_ID` | ✅ | Log channel ID (negative number) |
| `SUPER_ADMIN_ID` | ✅ | Your Telegram user ID |
| `BONUS_REFERRAL_DAYS` | ❌ | Default: 3 |
| `GRACE_PERIOD_DAYS` | ❌ | Default: 3 |
| `PORT` | ❌ | Health check port |

---

## Project Structure

```
src/
├── config/database.js
├── models/
│   ├── User.js            # + referralCode, referredBy, lastInteraction, isBlocked
│   ├── Plan.js
│   ├── Subscription.js    # + reminderFlags, graceDaysUsed, isRenewal
│   ├── Offer.js
│   ├── Request.js
│   ├── AdminLog.js        # NEW - admin audit trail
│   ├── SupportTicket.js   # NEW - support ticket system
│   └── DailySummary.js    # NEW - daily activity stats
├── services/
│   ├── userService.js
│   ├── subscriptionService.js
│   ├── adminService.js
│   ├── cronService.js     # 6 cron jobs
│   ├── referralService.js # NEW
│   ├── supportService.js  # NEW
│   └── analyticsService.js# NEW
├── bot/
│   ├── handlers.js        # User handlers (+ referral, support, renewal)
│   ├── adminHandlers.js   # Admin handlers (+ user search, tickets)
│   └── superAdminHandlers.js # Super admin (+ /stats, /planstats, /adminlogs)
├── utils/
│   ├── logger.js
│   ├── dateUtils.js
│   └── telegramUtils.js   # NEW - safeSend (403 detection), invite links
└── index.js
```

---

## Cron Schedule

| Job | Time | Purpose |
|---|---|---|
| reminderScheduler | 8:00 AM | Send 7/3/1/0-day expiry reminders |
| gracePeriodHandler | 9:00 AM | Process grace period & removals |
| inactiveUserDetector | 10:00 AM | Re-engage inactive users |
| membershipMonitor | 11:00 AM | Sync group membership vs subscriptions |
| dailySummary | 11:59 PM | Post activity summary to log channel |
| offerExpiryChecker | 12:05 AM | Deactivate expired offers |

---

## Command Reference

### User Commands
| Command | Description |
|---|---|
| `/start` | Main menu (handles referral code) |
| `/status` | Full subscription panel with renewal buttons |
| `/referral` | Your referral link and stats |
| `/support` | Open a support ticket |
| `/help` | Help menu |

### Admin Commands
| Command | Description |
|---|---|
| `/user <id>` | Full user profile + subscription info |
| `/plans` | List active plans |
| `/tickets` | View open support tickets |

### Super Admin Commands
| Command | Description |
|---|---|
| `/stats` | Growth dashboard |
| `/planstats` | Active users per plan |
| `/adminlogs` | Last 15 admin actions |
| `/addadmin <id>` | Promote to admin |
| `/removeadmin <id>` | Demote admin |
| `/createplan Name\|days\|price` | Create plan |
| `/editplan id\|field\|value` | Edit plan |
| `/pauseplan <id>` | Toggle pause |
| `/deleteplan <id>` | Delete plan |
| `/listplans` | All plans (incl. paused) |
| `/addoffer Title\|Desc\|DD/MM/YYYY\|discount` | Add offer |
| `/deleteoffer <id>` | Delete offer |
| `/listoffers` | Active offers |
| `/broadcast` | Broadcast to user segments |
| `/reports` | Sales reports |

---

## Grace Period Flow

```
Day 0 (expiry)   → Expired message + renewal buttons
Day +1           → Reminder: X days left before removal
Day +2           → Final warning
Day +3 (default) → Banned from group + renewal message
```

Configure with `GRACE_PERIOD_DAYS=3` in `.env`.

---

## Referral System

1. User gets unique referral link: `t.me/yourbot?start=ref_ABCD1234`
2. New user clicks link → `referredBy` is stored
3. When new user gets their **first** subscription approved → referrer earns `BONUS_REFERRAL_DAYS` extra days

---

## Production Deployment

```bash
# PM2
npm install -g pm2
pm2 start src/index.js --name telegram-sub-bot
pm2 save && pm2 startup
```

---

## License

MIT
