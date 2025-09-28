/**
 * Component for displaying streaming text with typing effect
 */

'use client';

import React, { useState, useEffect } from 'react';

export interface StreamingTextProps {
  text: string;
  speed?: number; // Characters per second
  onComplete?: () => void;
  className?: string;
  cursor?: boolean;
  cursorChar?: string;
}

/**
 * Component that displays text with a typing/streaming effect
 */
export function StreamingText({
  text,
  speed = 30,
  onComplete,
  className = '',
  cursor = true,
  cursorChar = '▊',
}: StreamingTextProps) {
  const [displayedText, setDisplayedText] = useState('');
  const [isComplete, setIsComplete] = useState(false);

  useEffect(() => {
    if (!text) {
      setDisplayedText('');
      setIsComplete(true);
      return;
    }

    let currentIndex = 0;
    const intervalMs = 1000 / speed;

    const timer = setInterval(() => {
      if (currentIndex <= text.length) {
        setDisplayedText(text.slice(0, currentIndex));
        currentIndex++;
      } else {
        clearInterval(timer);
        setIsComplete(true);
        if (onComplete) {
          onComplete();
        }
      }
    }, intervalMs);

    return () => clearInterval(timer);
  }, [text, speed, onComplete]);

  return (
    <span className={className}>
      {displayedText}
      {cursor && !isComplete && (
        <span className="animate-pulse">{cursorChar}</span>
      )}
    </span>
  );
}

export interface TypewriterProps {
  texts: string[];
  speed?: number;
  pauseBetween?: number;
  loop?: boolean;
  onComplete?: () => void;
  className?: string;
}

/**
 * Typewriter effect component for multiple texts
 */
export function Typewriter({
  texts,
  speed = 30,
  pauseBetween = 2000,
  loop = false,
  onComplete,
  className = '',
}: TypewriterProps) {
  const [currentTextIndex, setCurrentTextIndex] = useState(0);
  const [currentText, setCurrentText] = useState('');
  const [isTyping, setIsTyping] = useState(true);

  useEffect(() => {
    if (texts.length === 0) return;

    const text = texts[currentTextIndex] || '';
    let currentChar = 0;
    const intervalMs = 1000 / speed;

    if (isTyping) {
      // Typing phase
      const typingTimer = setInterval(() => {
        if (currentChar <= text.length) {
          setCurrentText(text.slice(0, currentChar));
          currentChar++;
        } else {
          clearInterval(typingTimer);
          setIsTyping(false);
        }
      }, intervalMs);

      return () => clearInterval(typingTimer);
    } else {
      // Pause phase
      const pauseTimer = setTimeout(() => {
        const nextIndex = currentTextIndex + 1;

        if (nextIndex < texts.length) {
          setCurrentTextIndex(nextIndex);
          setIsTyping(true);
        } else if (loop) {
          setCurrentTextIndex(0);
          setIsTyping(true);
        } else if (onComplete) {
          onComplete();
        }
      }, pauseBetween);

      return () => clearTimeout(pauseTimer);
    }
  }, [currentTextIndex, isTyping, texts, speed, pauseBetween, loop, onComplete]);

  return <span className={className}>{currentText}</span>;
}