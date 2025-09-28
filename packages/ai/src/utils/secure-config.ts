/**
 * Secure Configuration Manager
 * Handles sensitive data like API keys with encryption and validation
 */

import { createHash, randomBytes, createCipheriv, createDecipheriv } from 'crypto';
import { ValidationError } from '../errors';

export interface SecureConfigOptions {
  encryptionKey?: string;
  validateOnAccess?: boolean;
  maskInLogs?: boolean;
}

export class SecureConfig {
  private readonly encryptionKey: Buffer;
  private readonly algorithm = 'aes-256-gcm';
  private readonly configs: Map<string, { encrypted: string; iv: string; tag: string }> = new Map();
  private readonly validateOnAccess: boolean;
  private readonly maskInLogs: boolean;

  constructor(options: SecureConfigOptions = {}) {
    // Use provided key or derive from environment
    const key = options.encryptionKey || process.env['ENCRYPTION_KEY'] || 'default-dev-key-change-in-production';

    // Create a 32-byte key from the provided key
    this.encryptionKey = createHash('sha256').update(key).digest();
    this.validateOnAccess = options.validateOnAccess ?? true;
    this.maskInLogs = options.maskInLogs ?? true;
  }

  /**
   * Store a sensitive value securely
   */
  set(key: string, value: string): void {
    if (!value) {
      throw new ValidationError(`Cannot store empty value for key: ${key}`);
    }

    // Generate random initialization vector
    const iv = randomBytes(16);

    // Create cipher
    const cipher = createCipheriv(this.algorithm, this.encryptionKey, iv);

    // Encrypt the value
    let encrypted = cipher.update(value, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    // Get the authentication tag
    const tag = cipher.getAuthTag();

    // Store encrypted data
    this.configs.set(key, {
      encrypted,
      iv: iv.toString('hex'),
      tag: tag.toString('hex'),
    });
  }

  /**
   * Retrieve a sensitive value
   */
  get(key: string): string | undefined {
    const config = this.configs.get(key);
    if (!config) {
      return undefined;
    }

    try {
      // Create decipher
      const decipher = createDecipheriv(
        this.algorithm,
        this.encryptionKey,
        Buffer.from(config.iv, 'hex')
      );

      // Set the authentication tag
      decipher.setAuthTag(Buffer.from(config.tag, 'hex'));

      // Decrypt the value
      let decrypted = decipher.update(config.encrypted, 'hex', 'utf8');
      decrypted += decipher.final('utf8');

      // Validate if required
      if (this.validateOnAccess && !this.isValidApiKey(decrypted)) {
        throw new ValidationError(`Invalid API key format for key: ${key}`);
      }

      return decrypted;
    } catch (error) {
      throw new ValidationError(`Failed to decrypt value for key: ${key}`);
    }
  }

  /**
   * Check if a key exists
   */
  has(key: string): boolean {
    return this.configs.has(key);
  }

  /**
   * Remove a sensitive value
   */
  delete(key: string): void {
    this.configs.delete(key);
  }

  /**
   * Clear all stored values
   */
  clear(): void {
    this.configs.clear();
  }

  /**
   * Get masked version of a value for logging
   */
  getMasked(key: string): string | undefined {
    const value = this.get(key);
    if (!value || !this.maskInLogs) {
      return value;
    }

    return this.maskSensitiveValue(value);
  }

  /**
   * Validate API key format
   */
  private isValidApiKey(value: string): boolean {
    // Basic validation - at least 20 characters
    if (value.length < 20) {
      return false;
    }

    // Check for common API key patterns
    const patterns = [
      /^sk-[a-zA-Z0-9]{40,}$/,        // OpenAI pattern
      /^[a-zA-Z0-9]{32,}$/,            // Generic alphanumeric
      /^[a-zA-Z0-9-_]{40,}$/,          // With dashes and underscores
    ];

    return patterns.some(pattern => pattern.test(value));
  }

  /**
   * Mask sensitive value for logging
   */
  private maskSensitiveValue(value: string): string {
    if (value.length <= 8) {
      return '********';
    }

    const visibleStart = 4;
    const visibleEnd = 4;
    const masked = '*'.repeat(value.length - visibleStart - visibleEnd);

    return value.substring(0, visibleStart) + masked + value.substring(value.length - visibleEnd);
  }

  /**
   * Export configuration (encrypted)
   */
  export(): string {
    return JSON.stringify({
      configs: Array.from(this.configs.entries()),
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Import configuration (encrypted)
   */
  import(data: string): void {
    try {
      const parsed = JSON.parse(data);
      this.configs.clear();

      for (const [key, value] of parsed.configs) {
        this.configs.set(key, value);
      }
    } catch (error) {
      throw new ValidationError('Failed to import configuration');
    }
  }
}

/**
 * Global secure configuration instance
 */
export const secureConfig = new SecureConfig();

/**
 * Helper function to get API key securely
 */
export function getSecureApiKey(
  keyName: string,
  envVar?: string,
  defaultValue?: string
): string {
  // Check secure config first
  if (secureConfig.has(keyName)) {
    return secureConfig.get(keyName)!;
  }

  // Check environment variable
  if (envVar && process.env[envVar]) {
    const value = process.env[envVar]!;
    // Store in secure config for future use
    secureConfig.set(keyName, value);
    return value;
  }

  // Use default value if provided
  if (defaultValue) {
    secureConfig.set(keyName, defaultValue);
    return defaultValue;
  }

  throw new ValidationError(`API key not found: ${keyName}`);
}

/**
 * Helper function to validate and store API keys
 */
export function setSecureApiKey(keyName: string, value: string): void {
  if (!value || value.trim().length === 0) {
    throw new ValidationError(`Invalid API key for ${keyName}: empty value`);
  }

  // Remove any whitespace
  const cleanValue = value.trim();

  // Store securely
  secureConfig.set(keyName, cleanValue);
}

/**
 * Decorator for methods that use API keys
 */
export function SecureApiKey(keyName: string) {
  return function (
    _target: any,
    _propertyKey: string,
    descriptor: PropertyDescriptor
  ) {
    const originalMethod = descriptor.value;

    descriptor.value = async function (...args: any[]) {
      // Ensure API key is available
      const apiKey = getSecureApiKey(keyName);

      // Add API key to context or arguments as needed
      const context = { apiKey, ...this };

      return originalMethod.apply(context, args);
    };

    return descriptor;
  };
}