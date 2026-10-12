'use client';

import { useCallback, useRef } from 'react';
import { useViewport } from './use-viewport';

export type HapticFeedbackType = 'light' | 'medium' | 'heavy' | 'success' | 'warning' | 'error' | 'selection';

type TouchFeedbackOptions = {
  haptic?: HapticFeedbackType;
  visual?: boolean;
  audio?: boolean;
  duration?: number;
}

/**
 * Hook for providing touch feedback on mobile devices
 * Combines haptic, visual, and audio feedback for better user experience
 */
export function useTouchFeedback() {
  const viewport = useViewport();
  const audioContext = useRef<AudioContext | null>(null);

  // Initialize audio context on first user interaction
  const initAudio = useCallback(() => {
    if (!audioContext.current && typeof window !== 'undefined' && window.AudioContext) {
      audioContext.current = new AudioContext();
    }
  }, []);

  // Haptic feedback using the Vibration API
  const triggerHaptic = useCallback((type: HapticFeedbackType = 'light') => {
    if (!viewport.isTouch || typeof navigator === 'undefined' || !navigator.vibrate) {
      return;
    }

    const patterns: Record<HapticFeedbackType, number | number[]> = {
      light: 10,
      medium: 20,
      heavy: 30,
      success: [10, 50, 10],
      warning: [20, 100, 20],
      error: [50, 100, 50],
      selection: 15,
    };

    try {
      navigator.vibrate(patterns[type]);
    } catch (error) {
      console.debug('Haptic feedback not supported:', error);
    }
  }, [viewport.isTouch]);

  // Audio feedback for button presses
  const triggerAudio = useCallback((frequency = 200, duration = 50) => {
    if (!viewport.isTouch || !audioContext.current) {
      return;
    }

    try {
      const oscillator = audioContext.current.createOscillator();
      const gainNode = audioContext.current.createGain();

      oscillator.connect(gainNode);
      gainNode.connect(audioContext.current.destination);

      oscillator.frequency.value = frequency;
      oscillator.type = 'sine';

      gainNode.gain.setValueAtTime(0.1, audioContext.current.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.current.currentTime + duration / 1000);

      oscillator.start(audioContext.current.currentTime);
      oscillator.stop(audioContext.current.currentTime + duration / 1000);
    } catch (error) {
      console.debug('Audio feedback error:', error);
    }
  }, [viewport.isTouch]);

  // Combined feedback trigger
  const trigger = useCallback((options: TouchFeedbackOptions = {}) => {
    const {
      haptic = 'light',
      visual = true,
      audio = false,
      duration = 50,
    } = options;

    // Initialize audio on first interaction
    if (audio && !audioContext.current) {
      initAudio();
    }

    // Trigger haptic feedback
    if (haptic) {
      triggerHaptic(haptic);
    }

    // Trigger audio feedback
    if (audio) {
      const frequencies: Record<HapticFeedbackType, number> = {
        light: 200,
        medium: 250,
        heavy: 150,
        success: 400,
        warning: 300,
        error: 100,
        selection: 350,
      };
      triggerAudio(frequencies[haptic] || 200, duration);
    }

    // Visual feedback is handled by CSS classes in components
    return visual;
  }, [triggerHaptic, triggerAudio, initAudio]);

  // Touch event handlers with feedback
  const createTouchHandlers = useCallback((
    onPress: () => void,
    options: TouchFeedbackOptions = {}
  ) => {
    const handleTouchStart = (e: React.TouchEvent) => {
      e.preventDefault();
      trigger(options);
    };

    const handleTouchEnd = (e: React.TouchEvent) => {
      e.preventDefault();
      onPress();
    };

    return {
      onTouchStart: viewport.isTouch ? handleTouchStart : undefined,
      onTouchEnd: viewport.isTouch ? handleTouchEnd : undefined,
      onClick: viewport.isTouch ? undefined : onPress,
    };
  }, [trigger, viewport.isTouch]);

  return {
    trigger,
    triggerHaptic,
    triggerAudio,
    createTouchHandlers,
    isTouch: viewport.isTouch,
  };
}