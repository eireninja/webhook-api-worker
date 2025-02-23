/**
 * Custom error classes and error handling utilities
 */

export class ExchangeError extends Error {
  constructor(
    message: string,
    public readonly exchange: string,
    public readonly code?: string,
    public readonly metadata?: unknown
  ) {
    super(message);
    this.name = 'ExchangeError';
  }
}

export class ValidationError extends Error {
  constructor(
    message: string,
    public readonly field?: string,
    public readonly value?: unknown
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class AuthenticationError extends Error {
  constructor(
    message: string,
    public readonly exchange?: string
  ) {
    super(message);
    this.name = 'AuthenticationError';
  }
}
