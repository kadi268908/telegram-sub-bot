// src/models/SupportTicket.js
// Stores support tickets linked to Telegram Forum Topics.
// Each ticket = one forum topic thread in the SUPPORT_GROUP_ID.

const mongoose = require('mongoose');

const supportTicketSchema = new mongoose.Schema({
  // Auto-generated readable ID: TICK-0001
  ticketId: {
    type: String,
    unique: true,
  },

  // User who opened the ticket
  telegramId: {
    type: Number,
    required: true,
    index: true,
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  userName: { type: String, default: '' },
  userUsername: { type: String, default: null },

  // Forum topic created in SUPPORT_GROUP_ID
  topicId: {
    type: Number,
    required: true,
    unique: true,
    index: true,
  },

  // Opening message text
  firstMessage: {
    type: String,
    required: true,
  },

  status: {
    type: String,
    enum: ['open', 'closed'],
    default: 'open',
    index: true,
  },

  // Date string YYYY-MM-DD for daily limit checks
  openedDate: {
    type: String,
    required: true,
    index: true,
  },

  closedAt: { type: Date, default: null },
  closedBy: { type: Number, default: null },       // admin telegramId
  closedByUser: { type: Boolean, default: false },
}, { timestamps: true });

// Auto-generate TICK-XXXX before first save
supportTicketSchema.pre('save', async function (next) {
  if (!this.ticketId) {
    const count = await mongoose.model('SupportTicket').countDocuments();
    this.ticketId = `TICK-${String(count + 1).padStart(4, '0')}`;
  }
  next();
});

module.exports = mongoose.model('SupportTicket', supportTicketSchema);
