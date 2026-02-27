// src/models/Request.js
// Tracks premium access requests from users

const mongoose = require('mongoose');

const requestSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  telegramId: {
    type: Number,
    required: true,
    index: true,
  },
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending',
    index: true,
  },
  requestDate: {
    type: Date,
    default: Date.now,
  },
  actionDate: {
    type: Date,
    default: null,
  },
  actionBy: {
    type: Number, // admin/superadmin telegramId
    default: null,
  },
  selectedPlanId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Plan',
    default: null,
  },
  logMessageId: {
    type: Number, // message ID in log channel for editing
    default: null,
  },
}, { timestamps: true });

module.exports = mongoose.model('Request', requestSchema);
