const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema(
  {
    recipientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    recipientRole: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      index: true,
    },
    senderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },
    senderRole: {
      type: String,
      default: 'admin',
      trim: true,
      lowercase: true,
    },
    senderName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    type: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      default: 'admin_message',
      index: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 220,
    },
    message: {
      type: String,
      required: true,
      trim: true,
      maxlength: 400,
    },
    subject: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200,
    },
    preview: {
      type: String,
      required: true,
      trim: true,
      maxlength: 220,
    },
    urgent: {
      type: Boolean,
      default: false,
      index: true,
    },
    isViewed: {
      type: Boolean,
      default: false,
      index: true,
    },
    isCleared: {
      type: Boolean,
      default: false,
      index: true,
    },
    viewedAt: {
      type: Date,
      default: null,
    },
    messageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'AdminMessage',
      default: null,
      index: true,
    },
    meta: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('Notification', notificationSchema);
