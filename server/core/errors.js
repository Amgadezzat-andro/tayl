'use strict';
class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
class MigrationError extends Error {
  constructor(code, message) { super(message); this.name = 'MigrationError'; this.code = code; }
}
class BackupError extends Error {
  constructor(code, message) { super(message); this.name = 'BackupError'; this.code = code; }
}
class DecimalError extends Error {
  constructor(code, message) { super(message); this.name = 'DecimalError'; this.code = code; }
}
module.exports = { HttpError, MigrationError, BackupError, DecimalError };
