/**
 * Unit tests for cron pattern helpers
 *
 * These tests focus on the algorithmic code:
 * - Time parsing and validation
 * - Pattern generation logic
 * - Input validation and error handling
 */

import { describe, expect, it } from 'vitest';

import { CronPatterns } from './cron-patterns';

describe('CronPatterns', () => {
  describe('everySeconds', () => {
    it('should generate correct cron pattern for valid seconds', () => {
      expect(CronPatterns.everySeconds(5)).toBe('*/5 * * * * *');
      expect(CronPatterns.everySeconds(30)).toBe('*/30 * * * * *');
      expect(CronPatterns.everySeconds(1)).toBe('*/1 * * * * *');
      expect(CronPatterns.everySeconds(59)).toBe('*/59 * * * * *');
    });

    it('should throw error for seconds out of range', () => {
      expect(() => CronPatterns.everySeconds(0)).toThrow('Seconds must be between 1 and 59');
      expect(() => CronPatterns.everySeconds(60)).toThrow('Seconds must be between 1 and 59');
      expect(() => CronPatterns.everySeconds(-1)).toThrow('Seconds must be between 1 and 59');
      expect(() => CronPatterns.everySeconds(100)).toThrow('Seconds must be between 1 and 59');
    });
  });

  describe('everyMinutes', () => {
    it('should generate correct cron pattern for valid minutes', () => {
      expect(CronPatterns.everyMinutes(5)).toBe('*/5 * * * *');
      expect(CronPatterns.everyMinutes(15)).toBe('*/15 * * * *');
      expect(CronPatterns.everyMinutes(1)).toBe('*/1 * * * *');
      expect(CronPatterns.everyMinutes(59)).toBe('*/59 * * * *');
    });

    it('should throw error for minutes out of range', () => {
      expect(() => CronPatterns.everyMinutes(0)).toThrow('Minutes must be between 1 and 59');
      expect(() => CronPatterns.everyMinutes(60)).toThrow('Minutes must be between 1 and 59');
      expect(() => CronPatterns.everyMinutes(-5)).toThrow('Minutes must be between 1 and 59');
    });

    it('refuses NaN and fractions instead of building "*/NaN" patterns', () => {
      expect(() => CronPatterns.everyMinutes(Number.NaN)).toThrow('Minutes must be between 1 and 59');
      expect(() => CronPatterns.everyMinutes(1.5)).toThrow('Minutes must be between 1 and 59');
      expect(() => CronPatterns.everySeconds(Number.NaN)).toThrow('Seconds must be between 1 and 59');
      expect(() => CronPatterns.everyHours(2.5)).toThrow('Hours must be between 1 and 23');
      expect(() => CronPatterns.monthly(1.5, '09:00')).toThrow('Day of month must be between 1 and 31');
    });
  });

  describe('everyHours', () => {
    it('should generate correct cron pattern for valid hours', () => {
      expect(CronPatterns.everyHours(2)).toBe('0 0-23/2 * * *');
      expect(CronPatterns.everyHours(6)).toBe('0 0-23/6 * * *');
      expect(CronPatterns.everyHours(1)).toBe('0 0-23/1 * * *');
      expect(CronPatterns.everyHours(23)).toBe('0 0-23/23 * * *');
    });

    it('should throw error for hours out of range', () => {
      expect(() => CronPatterns.everyHours(0)).toThrow('Hours must be between 1 and 23');
      expect(() => CronPatterns.everyHours(24)).toThrow('Hours must be between 1 and 23');
      expect(() => CronPatterns.everyHours(-1)).toThrow('Hours must be between 1 and 23');
    });
  });

  describe('everyDays', () => {
    it('should generate correct cron pattern for valid days', () => {
      expect(CronPatterns.everyDays(2, '09:00')).toBe('0 9 */2 * *');
      expect(CronPatterns.everyDays(7, '14:30')).toBe('30 14 */7 * *');
      expect(CronPatterns.everyDays(1, '00:00')).toBe('0 0 */1 * *');
    });

    it('should throw error for days out of range', () => {
      expect(() => CronPatterns.everyDays(0, '09:00')).toThrow('Days must be between 1 and 31');
      expect(() => CronPatterns.everyDays(32, '09:00')).toThrow('Days must be between 1 and 31');
      expect(() => CronPatterns.everyDays(-1, '09:00')).toThrow('Days must be between 1 and 31');
    });

    it('should throw error for invalid time format', () => {
      expect(() => CronPatterns.everyDays(1, '25:00')).toThrow('Invalid hours: 25. Must be 0-23');
      expect(() => CronPatterns.everyDays(1, '12:60')).toThrow('Invalid minutes: 60. Must be 0-59');
    });
  });

  describe('daily', () => {
    it('should generate correct cron pattern for HH:mm format', () => {
      expect(CronPatterns.daily('09:00')).toBe('0 9 * * *');
      expect(CronPatterns.daily('14:30')).toBe('30 14 * * *');
      expect(CronPatterns.daily('00:00')).toBe('0 0 * * *');
      expect(CronPatterns.daily('23:59')).toBe('59 23 * * *');
    });

    it('should handle HH format (no minutes)', () => {
      expect(CronPatterns.daily('09')).toBe('0 9 * * *');
      expect(CronPatterns.daily('23')).toBe('0 23 * * *');
      expect(CronPatterns.daily('00')).toBe('0 0 * * *');
    });

    it('should throw error for invalid hours', () => {
      expect(() => CronPatterns.daily('24:00')).toThrow('Invalid hours: 24. Must be 0-23');
      expect(() => CronPatterns.daily('-1:00')).toThrow('Invalid hours: -1. Must be 0-23');
      expect(() => CronPatterns.daily('abc:00')).toThrow('Invalid hours: abc. Must be 0-23');
    });

    it('should throw error for invalid minutes', () => {
      expect(() => CronPatterns.daily('12:60')).toThrow('Invalid minutes: 60. Must be 0-59');
      expect(() => CronPatterns.daily('12:-1')).toThrow('Invalid minutes: -1. Must be 0-59');
      expect(() => CronPatterns.daily('12:abc')).toThrow('Invalid minutes: abc. Must be 0-59');
    });
  });

  describe('weekdays', () => {
    it('should generate correct cron pattern for weekdays', () => {
      expect(CronPatterns.weekdays('09:00')).toBe('0 9 * * 1-5');
      expect(CronPatterns.weekdays('14:30')).toBe('30 14 * * 1-5');
      expect(CronPatterns.weekdays('17:30')).toBe('30 17 * * 1-5');
    });

    it('should handle HH format without minutes', () => {
      expect(CronPatterns.weekdays('09')).toBe('0 9 * * 1-5');
    });

    it('should throw error for invalid time', () => {
      expect(() => CronPatterns.weekdays('25:00')).toThrow('Invalid hours');
      expect(() => CronPatterns.weekdays('12:70')).toThrow('Invalid minutes');
    });
  });

  describe('weekends', () => {
    it('should generate correct cron pattern for weekends', () => {
      expect(CronPatterns.weekends('10:00')).toBe('0 10 * * 0,6');
      expect(CronPatterns.weekends('14:00')).toBe('0 14 * * 0,6');
      expect(CronPatterns.weekends('08:30')).toBe('30 8 * * 0,6');
    });

    it('should handle edge times', () => {
      expect(CronPatterns.weekends('00:00')).toBe('0 0 * * 0,6');
      expect(CronPatterns.weekends('23:59')).toBe('59 23 * * 0,6');
    });
  });

  describe('weekly', () => {
    it('should generate correct cron pattern for each day of week', () => {
      expect(CronPatterns.weekly('monday', '09:00')).toBe('0 9 * * 1');
      expect(CronPatterns.weekly('tuesday', '09:00')).toBe('0 9 * * 2');
      expect(CronPatterns.weekly('wednesday', '09:00')).toBe('0 9 * * 3');
      expect(CronPatterns.weekly('thursday', '09:00')).toBe('0 9 * * 4');
      expect(CronPatterns.weekly('friday', '17:00')).toBe('0 17 * * 5');
      expect(CronPatterns.weekly('saturday', '10:00')).toBe('0 10 * * 6');
      expect(CronPatterns.weekly('sunday', '10:00')).toBe('0 10 * * 0');
    });

    it('should handle different time formats', () => {
      expect(CronPatterns.weekly('monday', '14:30')).toBe('30 14 * * 1');
      expect(CronPatterns.weekly('friday', '09')).toBe('0 9 * * 5');
    });

    it('should throw error for invalid time', () => {
      expect(() => CronPatterns.weekly('monday', '25:00')).toThrow('Invalid hours');
      expect(() => CronPatterns.weekly('friday', '12:70')).toThrow('Invalid minutes');
    });
  });

  describe('monthly', () => {
    it('should generate correct cron pattern for valid days', () => {
      expect(CronPatterns.monthly(1, '09:00')).toBe('0 9 1 * *');
      expect(CronPatterns.monthly(15, '12:00')).toBe('0 12 15 * *');
      expect(CronPatterns.monthly(31, '23:59')).toBe('59 23 31 * *');
    });

    it('should handle single-digit days', () => {
      expect(CronPatterns.monthly(1, '00:00')).toBe('0 0 1 * *');
      expect(CronPatterns.monthly(9, '09:00')).toBe('0 9 9 * *');
    });

    it('should throw error for invalid day of month', () => {
      expect(() => CronPatterns.monthly(0, '09:00')).toThrow('Day of month must be between 1 and 31');
      expect(() => CronPatterns.monthly(32, '09:00')).toThrow('Day of month must be between 1 and 31');
      expect(() => CronPatterns.monthly(-1, '09:00')).toThrow('Day of month must be between 1 and 31');
    });

    it('should throw error for invalid time', () => {
      expect(() => CronPatterns.monthly(15, '25:00')).toThrow('Invalid hours');
      expect(() => CronPatterns.monthly(15, '12:70')).toThrow('Invalid minutes');
    });
  });

  describe('monthlyStart', () => {
    it('should generate correct cron pattern for first day of month', () => {
      expect(CronPatterns.monthlyStart('09:00')).toBe('0 9 1 * *');
      expect(CronPatterns.monthlyStart('00:00')).toBe('0 0 1 * *');
      expect(CronPatterns.monthlyStart('14:30')).toBe('30 14 1 * *');
    });

    it('should throw error for invalid time', () => {
      expect(() => CronPatterns.monthlyStart('25:00')).toThrow('Invalid hours');
    });
  });

  describe('monthlyEnd', () => {
    it('should generate correct cron pattern for 28th day (safe for all months)', () => {
      expect(CronPatterns.monthlyEnd('23:59')).toBe('59 23 28 * *');
      expect(CronPatterns.monthlyEnd('00:00')).toBe('0 0 28 * *');
    });
  });

  describe('quarterly', () => {
    it('should generate correct cron pattern for quarterly execution', () => {
      expect(CronPatterns.quarterly('09:00')).toBe('0 9 1 */3 *');
      expect(CronPatterns.quarterly('00:00')).toBe('0 0 1 */3 *');
      expect(CronPatterns.quarterly('14:30')).toBe('30 14 1 */3 *');
    });
  });

  describe('yearly', () => {
    it('should generate correct cron pattern for January 1st', () => {
      expect(CronPatterns.yearly('00:00')).toBe('0 0 1 1 *');
      expect(CronPatterns.yearly('09:00')).toBe('0 9 1 1 *');
      expect(CronPatterns.yearly('23:59')).toBe('59 23 1 1 *');
    });
  });

  describe('Common Presets', () => {
    it('should have correct second-based patterns', () => {
      expect(CronPatterns.everySecond).toBe('* * * * * *');
      expect(CronPatterns.everyFiveSeconds).toBe('*/5 * * * * *');
      expect(CronPatterns.everyTenSeconds).toBe('*/10 * * * * *');
      expect(CronPatterns.everyThirtySeconds).toBe('*/30 * * * * *');
    });

    it('should have correct minute-based patterns', () => {
      expect(CronPatterns.everyMinute).toBe('*/1 * * * *');
      expect(CronPatterns.everyFiveMinutes).toBe('*/5 * * * *');
      expect(CronPatterns.everyTenMinutes).toBe('*/10 * * * *');
      expect(CronPatterns.everyFifteenMinutes).toBe('*/15 * * * *');
      expect(CronPatterns.everyThirtyMinutes).toBe('*/30 * * * *');
    });

    it('should have correct hourly patterns', () => {
      expect(CronPatterns.hourly).toBe('0 * * * *');
      expect(CronPatterns.everyTwoHours).toBe('0 */2 * * *');
      expect(CronPatterns.everyThreeHours).toBe('0 */3 * * *');
      expect(CronPatterns.everyFourHours).toBe('0 */4 * * *');
      expect(CronPatterns.everySixHours).toBe('0 */6 * * *');
      expect(CronPatterns.everyTwelveHours).toBe('0 */12 * * *');
    });

    it('should have correct daily patterns', () => {
      expect(CronPatterns.midnight).toBe('0 0 * * *');
      expect(CronPatterns.noon).toBe('0 12 * * *');
      expect(CronPatterns.morningAt6).toBe('0 6 * * *');
      expect(CronPatterns.morningAt9).toBe('0 9 * * *');
      expect(CronPatterns.eveningAt6).toBe('0 18 * * *');
    });

    it('should have correct weekly patterns', () => {
      expect(CronPatterns.mondayMorning).toBe('0 9 * * 1');
      expect(CronPatterns.fridayEvening).toBe('0 17 * * 5');
    });

    it('should have correct monthly patterns', () => {
      expect(CronPatterns.monthlyAtMidnight).toBe('0 0 1 * *');
      expect(CronPatterns.monthlyAtNine).toBe('0 9 1 * *');
    });
  });

  describe('Time Parsing Edge Cases', () => {
    it('should handle leading zeros', () => {
      expect(CronPatterns.daily('09:05')).toBe('5 9 * * *');
      expect(CronPatterns.daily('00:00')).toBe('0 0 * * *');
      expect(CronPatterns.weekly('monday', '08:07')).toBe('7 8 * * 1');
    });

    it('should handle boundary values', () => {
      expect(CronPatterns.daily('00:00')).toBe('0 0 * * *');
      expect(CronPatterns.daily('23:59')).toBe('59 23 * * *');
    });

    it('should reject malformed time strings', () => {
      expect(() => CronPatterns.daily('invalid')).toThrow('Invalid hours');
      expect(() => CronPatterns.daily('12:34:56')).toThrow(); // Too many parts
      expect(() => CronPatterns.daily('')).toThrow('Invalid hours');
    });
  });

  describe('Type Safety', () => {
    it('should only accept valid day names for weekly', () => {
      // This test verifies TypeScript compile-time type safety
      // At runtime, we just verify the valid values work
      const validDays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;

      for (const day of validDays) {
        expect(() => CronPatterns.weekly(day, '09:00')).not.toThrow();
      }
    });
  });

  describe('Real-World Scenarios', () => {
    it('should generate pattern for business hours daily report', () => {
      const pattern = CronPatterns.weekdays('17:00');
      expect(pattern).toBe('0 17 * * 1-5');
    });

    it('should generate pattern for weekly backup on Sunday', () => {
      const pattern = CronPatterns.weekly('sunday', '02:00');
      expect(pattern).toBe('0 2 * * 0');
    });

    it('should generate pattern for monthly billing on first day', () => {
      const pattern = CronPatterns.monthly(1, '00:00');
      expect(pattern).toBe('0 0 1 * *');
    });

    it('should generate pattern for health check every 30 seconds', () => {
      const pattern = CronPatterns.everySeconds(30);
      expect(pattern).toBe('*/30 * * * * *');
    });

    it('should generate pattern for cache cleanup every 6 hours', () => {
      const pattern = CronPatterns.everyHours(6);
      expect(pattern).toBe('0 0-23/6 * * *');
    });

    it('should generate pattern for quarterly reports', () => {
      const pattern = CronPatterns.quarterly('09:00');
      expect(pattern).toBe('0 9 1 */3 *');
    });
  });
});
