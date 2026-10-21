import type { ReactNode } from 'react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { cn } from '@arki/ui/cn';

import type { GlossaryEntry } from './glossary';
import { useHydrated } from './use-hydrated';

type OpenTerm = {
  /** The instance of the word on the page, since one word can appear many times. */
  id: string;
  word: string;
  entry: GlossaryEntry;
  element: HTMLElement;
};

type GlossaryApi = {
  open: OpenTerm | null;
  show: (term: OpenTerm) => void;
  hide: (id: string) => void;
  toggle: (term: OpenTerm) => void;
};

const GlossaryContext = createContext<GlossaryApi | null>(null);

const TIP_ID = 'glossary-tip';
const EDGE = 12;
const GAP = 8;

/** Puts the tooltip beside its word: above if there is room, else below, and always inside the viewport. */
function placeTip(tip: HTMLElement, word: HTMLElement) {
  const anchor = word.getBoundingClientRect();
  const { width, height } = tip.getBoundingClientRect();
  const left = Math.min(Math.max(anchor.left + anchor.width / 2 - width / 2, EDGE), window.innerWidth - width - EDGE);
  const above = anchor.top - height - GAP;
  tip.style.left = `${Math.max(EDGE, left)}px`;
  tip.style.top = `${above >= EDGE ? above : anchor.bottom + GAP}px`;
}

function Tip({ open, onClose }: Readonly<{ open: OpenTerm | null; onClose: () => void }>) {
  const tip = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (open !== null && tip.current !== null) placeTip(tip.current, open.element);
  }, [open]);
  // The page scrolls under an open tooltip (a focused word is scrolled into view): follow the word, and close the
  // tooltip only once the word has left the screen.
  useEffect(() => {
    const word = open?.element;
    const box = tip.current;
    if (word === undefined || box === null) return;
    const follow = () => {
      const { top, bottom } = word.getBoundingClientRect();
      if (bottom < 0 || top > window.innerHeight) onClose();
      else placeTip(box, word);
    };
    document.addEventListener('scroll', follow, { capture: true, passive: true });
    window.addEventListener('resize', follow);
    return () => {
      document.removeEventListener('scroll', follow, { capture: true });
      window.removeEventListener('resize', follow);
    };
  }, [open, onClose]);
  return (
    <div id={TIP_ID} className="home-tip" role="tooltip" ref={tip} hidden={open === null}>
      {open === null ? null : (
        <>
          <p className="home-tip-word">{open.entry.method === true ? `.${open.word}` : open.word}</p>
          <p>{open.entry.text}</p>
          <p className="home-tip-where">{open.entry.where}</p>
        </>
      )}
    </div>
  );
}

/** Holds which glossary word is open (one at a time) and draws its tooltip. */
export function GlossaryProvider({ children }: Readonly<{ children: ReactNode }>) {
  const [open, setOpen] = useState<OpenTerm | null>(null);
  const api = useMemo<GlossaryApi>(
    () => ({
      open,
      show: term => setOpen(term),
      hide: id => setOpen(current => (current?.id === id ? null : current)),
      toggle: term => setOpen(current => (current?.id === term.id ? null : term)),
    }),
    [open],
  );
  const closeAll = useCallback(() => setOpen(null), []);
  const isOpen = open !== null;
  useEffect(() => {
    if (!isOpen) return;
    const close = () => setOpen(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    const onPointer = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || event.target.closest('.tk-term') === null) close();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [isOpen]);
  return (
    <GlossaryContext.Provider value={api}>
      {children}
      <Tip open={open} onClose={closeAll} />
    </GlossaryContext.Provider>
  );
}

type TermProps = {
  word: string;
  entry: GlossaryEntry;
  className?: string;
  children: ReactNode;
};

/**
 * A word of code that explains itself. It is a real button drawn as code, so the keyboard reaches it and the text
 * still copies. Hover, keyboard focus and tap open the tooltip; Escape or a tap elsewhere closes it.
 */
export function GlossaryTerm({ word, entry, className, children }: Readonly<TermProps>) {
  const api = useContext(GlossaryContext);
  const id = useId();
  const pointer = useRef('');
  const hydrated = useHydrated();
  // Without JavaScript, and until the page is interactive, a word is plain text: a button that does nothing is worse.
  if (api === null || !hydrated) return <span className={className}>{children}</span>;
  const isOpen = api.open?.id === id;
  const term = (element: HTMLElement): OpenTerm => ({ id, word, entry, element });
  return (
    <button
      type="button"
      className={cn(className, 'tk-term', isOpen && 'is-open')}
      aria-describedby={isOpen ? TIP_ID : undefined}
      onPointerDown={event => {
        pointer.current = event.pointerType;
      }}
      onKeyDown={() => {
        pointer.current = 'keyboard';
      }}
      onPointerEnter={event => {
        if (event.pointerType === 'mouse') api.show(term(event.currentTarget));
      }}
      onPointerLeave={event => {
        if (event.pointerType === 'mouse') api.hide(id);
      }}
      onFocus={event => {
        if (event.currentTarget.matches(':focus-visible')) api.show(term(event.currentTarget));
      }}
      onBlur={() => api.hide(id)}
      onClick={event => {
        // A mouse click already opened it on hover; a tap or a key press toggles it.
        if (pointer.current !== 'mouse') api.toggle(term(event.currentTarget));
      }}
    >
      {children}
    </button>
  );
}
