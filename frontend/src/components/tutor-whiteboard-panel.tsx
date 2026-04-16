"use client";

import * as React from "react";
import { Kalam } from "next/font/google";

import { cn } from "@/lib/utils";

const kalam = Kalam({
  weight: ["400", "700"],
  subsets: ["latin"],
  display: "swap",
});

const whiteboardShell =
  "relative overflow-hidden rounded-2xl border border-emerald-900/15 bg-gradient-to-br from-emerald-50/90 via-white to-sky-50/50 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.85)] dark:border-emerald-500/20 dark:from-emerald-950/35 dark:via-background dark:to-slate-950/40";

/** Classroom-style board: matte surface, frame, soft inner shadow */
const whiteboardShellImmersive =
  "rounded-2xl border-[3px] border-emerald-900/25 bg-[#f3f6f4] p-6 shadow-[0_8px_40px_-12px_rgba(15,80,50,0.25),inset_0_2px_0_rgba(255,255,255,0.75),inset_0_-3px_12px_rgba(0,50,30,0.06)] dark:border-emerald-600/30 dark:bg-[#141c18] dark:shadow-[0_8px_40px_-12px_rgba(0,0,0,0.5),inset_0_1px_0_rgba(255,255,255,0.06)]";

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = React.useState(false);
  React.useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const fn = () => setReduced(mq.matches);
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, []);
  return reduced;
}

/** Human-like delay before the next character (ms). */
function delayBeforeNextChar(prevChar: string, nextChar: string | undefined): number {
  if (nextChar === undefined) return 0;
  const jitter = () => Math.random() * 32;
  if (prevChar === "\n") return 95 + Math.random() * 70;
  if (nextChar === " ") return 38 + Math.random() * 55;
  if (".!?".includes(prevChar)) return 130 + Math.random() * 90;
  if (",;:".includes(prevChar)) return 72 + Math.random() * 55;
  if (prevChar === " ") return 22 + Math.random() * 38;
  if (prevChar === "-") return 35 + Math.random() * 40;
  return 16 + jitter();
}

/** Animate one bullet; returns cleanup to cancel. */
function runCharReveal(
  full: string,
  onChar: (partial: string) => void,
  reducedMotion: boolean,
  onComplete?: () => void,
): () => void {
  if (reducedMotion) {
    onChar(full);
    onComplete?.();
    return () => {};
  }
  let cancelled = false;
  const timers: ReturnType<typeof setTimeout>[] = [];
  let i = 0;

  const schedule = (fn: () => void, ms: number) => {
    const id = setTimeout(() => {
      const pos = timers.indexOf(id);
      if (pos >= 0) timers.splice(pos, 1);
      fn();
    }, ms);
    timers.push(id);
  };

  const step = () => {
    if (cancelled) return;
    if (i >= full.length) {
      onComplete?.();
      return;
    }
    i += 1;
    onChar(full.slice(0, i));
    if (i >= full.length) {
      onComplete?.();
      return;
    }
    const prev = full[i - 1]!;
    const next = full[i];
    schedule(step, delayBeforeNextChar(prev, next));
  };

  schedule(step, 40 + Math.random() * 80);

  return () => {
    cancelled = true;
    timers.forEach(clearTimeout);
  };
}

export type TutorLectureWhiteboardHandle = {
  /** Title visible, all bullets hidden. */
  reset: () => void;
  /** Show every bullet at full text (non–step-sync playback e.g. ELI5 or resume). */
  fillAllBullets: () => void;
  /** Hand-write bullet `index`; resolves when finished. */
  animateBullet: (index: number) => Promise<void>;
};

export type TutorLectureWhiteboardProps = {
  title: string;
  points: string[];
  className?: string;
  /** Stronger “classroom whiteboard” frame (fullscreen teaching). */
  presentation?: "default" | "immersive";
  pointRefs?: React.MutableRefObject<(HTMLLIElement | null)[]>;
  narrationBulletIndex: number | null;
  narrationActive: boolean;
};

/**
 * Teaching-synchronized whiteboard: title always visible; bullets are revealed only via ref
 * (`animateBullet`) so playback can pause, write, then speak — no full-slide dump.
 */
export const TutorLectureWhiteboard = React.forwardRef<TutorLectureWhiteboardHandle, TutorLectureWhiteboardProps>(
  function TutorLectureWhiteboard(
    {
      title,
      points,
      className,
      presentation = "default",
      pointRefs,
      narrationBulletIndex,
      narrationActive,
    },
    ref,
  ) {
    const reducedMotion = usePrefersReducedMotion();
    /** Per-bullet visible text; empty = not yet revealed (hidden). */
    const [bulletText, setBulletText] = React.useState<string[]>(() => points.map(() => ""));
    const [writingIndex, setWritingIndex] = React.useState<number | null>(null);
    const pointsKey = points.join("\u0000");

    React.useEffect(() => {
      setBulletText(points.map(() => ""));
      setWritingIndex(null);
    }, [pointsKey, points]);

    const revealCancelRef = React.useRef<(() => void) | null>(null);

    React.useImperativeHandle(
      ref,
      () => ({
        reset: () => {
          revealCancelRef.current?.();
          revealCancelRef.current = null;
          setBulletText(points.map(() => ""));
          setWritingIndex(null);
        },
        fillAllBullets: () => {
          revealCancelRef.current?.();
          revealCancelRef.current = null;
          setWritingIndex(null);
          setBulletText([...points]);
        },
        animateBullet: (index: number) => {
          return new Promise<void>((resolve) => {
            if (index < 0 || index >= points.length) {
              resolve();
              return;
            }
            revealCancelRef.current?.();
            revealCancelRef.current = null;
            const full = points[index] ?? "";
            if (!full.length) {
              setBulletText((prev) => {
                const next = [...prev];
                next[index] = "";
                return next;
              });
              resolve();
              return;
            }
            setWritingIndex(index);
            setBulletText((prev) => {
              const next = [...prev];
              next[index] = "";
              return next;
            });
            revealCancelRef.current = runCharReveal(
              full,
              (partial) => {
                setBulletText((prev) => {
                  const next = [...prev];
                  next[index] = partial;
                  return next;
                });
              },
              reducedMotion,
              () => {
                setWritingIndex(null);
                revealCancelRef.current = null;
                resolve();
              },
            );
          });
        },
      }),
      [points, pointsKey, reducedMotion],
    );

    const shell = presentation === "immersive" ? whiteboardShellImmersive : whiteboardShell;
    const gridOpacity = presentation === "immersive" ? "opacity-[0.45]" : "opacity-[0.35]";

    return (
      <div className={cn(kalam.className, shell, "space-y-4", className)}>
        <div
          className={cn(
            "pointer-events-none absolute inset-0 rounded-2xl [background-image:repeating-linear-gradient(-12deg,rgba(16,185,129,0.06)_0,rgba(16,185,129,0.06)_1px,transparent_1px,transparent_14px)] dark:opacity-[0.2]",
            gridOpacity,
          )}
        />
        {presentation === "immersive" ? (
          <div
            className="pointer-events-none absolute inset-0 rounded-[13px] opacity-[0.12] [background-image:radial-gradient(circle_at_20%_10%,rgba(255,255,255,0.9),transparent_45%),radial-gradient(circle_at_80%_90%,rgba(0,80,40,0.04),transparent_40%)] dark:opacity-[0.15]"
            aria-hidden
          />
        ) : null}

        <div className="relative space-y-1">
          <h2
            className={cn(
              "text-2xl font-bold leading-tight tracking-tight text-emerald-950 dark:text-emerald-100",
              narrationActive && "drop-shadow-sm",
            )}
          >
            {title}
          </h2>
        </div>

        <ul className="relative space-y-3">
          {points.map((full, i) => {
            const shown = bulletText[i] ?? "";
            const hidden = shown.length === 0 && writingIndex !== i;
            const showCursor = writingIndex === i && shown.length < full.length;
            const isFocused =
              !hidden &&
              narrationActive &&
              (narrationBulletIndex === i || writingIndex === i);
            const isSecondary = !hidden && narrationActive && !isFocused;
            return (
              <li
                key={`wb-${i}-${full.slice(0, 24)}`}
                ref={(el) => {
                  if (pointRefs?.current) pointRefs.current[i] = el;
                }}
                hidden={hidden}
                className={cn(
                  "flex gap-2.5 rounded-xl border transition-all duration-300 ease-out",
                  hidden && "m-0 h-0 overflow-hidden border-0 p-0 opacity-0",
                  !hidden && !isFocused && "border-transparent py-2 pl-2 pr-2 hover:bg-white/50 dark:hover:bg-white/5",
                  !hidden &&
                    !isFocused &&
                    "before:mt-2 before:size-1.5 before:shrink-0 before:rounded-full before:bg-emerald-600/35 before:content-[''] dark:before:bg-emerald-400/40",
                  isFocused &&
                    "relative z-10 scale-[1.02] border-emerald-500/55 bg-emerald-500/[0.16] py-3.5 pl-3.5 pr-3.5 shadow-lg ring-2 ring-emerald-500/40 before:mt-2.5 before:size-2 before:shrink-0 before:rounded-full before:bg-emerald-600 before:content-[''] before:shadow-sm dark:border-emerald-400/35 dark:bg-emerald-500/20 dark:ring-emerald-400/35 dark:before:bg-emerald-300",
                  isSecondary && "opacity-[0.78]",
                )}
              >
                {!hidden ? (
                  <span
                    className={cn(
                      "min-w-0 text-emerald-950/95 dark:text-emerald-50/95",
                      isFocused &&
                        "text-[1.15rem] font-semibold leading-relaxed sm:text-xl sm:leading-relaxed",
                      isSecondary && "text-sm leading-snug",
                      !isFocused && !isSecondary && "text-base leading-snug",
                    )}
                  >
                    {shown}
                    {showCursor ? (
                      <span
                        className={cn(
                          "ml-0.5 inline-block animate-pulse align-[-0.1em]",
                          isFocused
                            ? "h-[1.1em] w-[3px] rounded-sm bg-emerald-700 dark:bg-emerald-200"
                            : "h-[1.05em] w-0.5 bg-emerald-700/85 dark:bg-emerald-200/90",
                        )}
                        aria-hidden
                      />
                    ) : null}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>
    );
  },
);

/**
 * Q&A answer bullets only: same imperative handwriting API as `TutorLectureWhiteboard`, driven by
 * playback segment index from the tutor page (time-synced with TTS).
 */
const TutorQaAnswerOutline = React.forwardRef<TutorLectureWhiteboardHandle, {
  bullets: string[];
  qaBulletRefs?: React.MutableRefObject<(HTMLLIElement | null)[]>;
  answerBulletIndex: number | null;
  /** True while answer audio is playing or paused mid-reply (keeps partial handwriting). */
  answerVisualActive: boolean;
  /** When true, show full bullet text (idle after reply, or before first play). */
  fillWhenIdle: boolean;
}>(function TutorQaAnswerOutline(
  { bullets, qaBulletRefs, answerBulletIndex, answerVisualActive, fillWhenIdle },
  ref,
) {
  const reducedMotion = usePrefersReducedMotion();
  const [bulletText, setBulletText] = React.useState<string[]>(() => bullets.map(() => ""));
  const [writingIndex, setWritingIndex] = React.useState<number | null>(null);
  const bulletsKey = bullets.join("\u0000");
  const revealCancelRef = React.useRef<(() => void) | null>(null);
  const prevBulletsKeyRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    const bulletsChanged = prevBulletsKeyRef.current !== bulletsKey;
    prevBulletsKeyRef.current = bulletsKey;
    revealCancelRef.current?.();
    revealCancelRef.current = null;
    setWritingIndex(null);
    if (fillWhenIdle) {
      setBulletText([...bullets]);
    } else if (bulletsChanged) {
      setBulletText(bullets.map(() => ""));
    }
  }, [bulletsKey, bullets, fillWhenIdle]);

  React.useImperativeHandle(
    ref,
    () => ({
      reset: () => {
        revealCancelRef.current?.();
        revealCancelRef.current = null;
        setBulletText(bullets.map(() => ""));
        setWritingIndex(null);
      },
      fillAllBullets: () => {
        revealCancelRef.current?.();
        revealCancelRef.current = null;
        setWritingIndex(null);
        setBulletText([...bullets]);
      },
      animateBullet: (index: number) => {
        return new Promise<void>((resolve) => {
          if (index < 0 || index >= bullets.length) {
            resolve();
            return;
          }
          revealCancelRef.current?.();
          revealCancelRef.current = null;
          const full = bullets[index] ?? "";
          if (!full.length) {
            setBulletText((prev) => {
              const next = [...prev];
              next[index] = "";
              return next;
            });
            resolve();
            return;
          }
          setWritingIndex(index);
          setBulletText((prev) => {
            const next = [...prev];
            next[index] = "";
            return next;
          });
          revealCancelRef.current = runCharReveal(
            full,
            (partial) => {
              setBulletText((prev) => {
                const next = [...prev];
                next[index] = partial;
                return next;
              });
            },
            reducedMotion,
            () => {
              setWritingIndex(null);
              revealCancelRef.current = null;
              resolve();
            },
          );
        });
      },
    }),
    [bullets, bulletsKey, reducedMotion],
  );

  return (
    <div>
      <p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Answer outline</p>
      <ul className="space-y-2">
        {bullets.map((full, i) => {
          const shown = bulletText[i] ?? "";
          const hidden = shown.length === 0 && writingIndex !== i;
          const showCursor = writingIndex === i && shown.length < full.length;
          const isFocused =
            !hidden && answerVisualActive && (answerBulletIndex === i || writingIndex === i);
          const isSecondary = !hidden && answerVisualActive && !isFocused;
          return (
            <li
              key={`qawb-${i}-${full.slice(0, 20)}`}
              ref={(el) => {
                if (qaBulletRefs?.current) qaBulletRefs.current[i] = el;
              }}
              hidden={hidden}
              className={cn(
                "list-none rounded-xl border px-3 py-2.5 text-sm leading-snug transition-all duration-300",
                hidden && "m-0 h-0 overflow-hidden border-0 p-0 opacity-0",
                isFocused &&
                  "relative z-10 scale-[1.02] border-primary/55 bg-primary/[0.16] py-3 pl-3.5 pr-3.5 shadow-lg ring-2 ring-primary/40",
                !hidden && !isFocused && isSecondary && "border-border/70 bg-muted/30 opacity-[0.78]",
                !hidden && !isFocused && !isSecondary && "border-border/70 bg-muted/30",
              )}
            >
              {!hidden ? (
                <span
                  className={cn(
                    "min-w-0 text-foreground",
                    isFocused && "text-[1.05rem] font-semibold leading-relaxed",
                    isSecondary && "text-xs leading-snug",
                    !isFocused && !isSecondary && "leading-snug",
                  )}
                >
                  {shown}
                  {showCursor ? (
                    <span
                      className={cn(
                        "ml-0.5 inline-block animate-pulse align-[-0.1em]",
                        isFocused
                          ? "h-[1.1em] w-[3px] rounded-sm bg-primary"
                          : "h-[1em] w-0.5 bg-primary/80",
                      )}
                      aria-hidden
                    />
                  ) : null}
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
});

export type TutorQaWhiteboardProps = {
  askerLabel: string;
  question: string;
  bullets: string[];
  className?: string;
  presentation?: "default" | "immersive";
  qaBulletRefs?: React.MutableRefObject<(HTMLLIElement | null)[]>;
  answerBulletIndex: number | null;
  /** While false, answer bullets show in full for reading; playback uses ref-driven handwriting. */
  fillAnswerOutlineWhenIdle: boolean;
  /** Pass through for bullet focus when paused mid-answer. */
  answerVisualActive: boolean;
};

export const TutorQaWhiteboard = React.forwardRef<TutorLectureWhiteboardHandle, TutorQaWhiteboardProps>(
  function TutorQaWhiteboard(
    {
      askerLabel,
      question,
      bullets,
      className,
      presentation = "default",
      qaBulletRefs,
      answerBulletIndex,
      fillAnswerOutlineWhenIdle,
      answerVisualActive,
    },
    ref,
  ) {
    const qaTopShell = presentation === "immersive" ? whiteboardShellImmersive : whiteboardShell;

    return (
      <div className={cn(kalam.className, "space-y-4", className)}>
        <div className={cn(qaTopShell, "relative space-y-3 overflow-hidden")}>
          <div className="pointer-events-none absolute inset-0 rounded-2xl opacity-[0.35] [background-image:repeating-linear-gradient(-12deg,rgba(139,92,246,0.07)_0,rgba(139,92,246,0.07)_1px,transparent_1px,transparent_14px)] dark:opacity-[0.2]" />
          <div className="relative">
            <p className="text-xs font-bold uppercase tracking-wider text-violet-900 dark:text-violet-200">
              {askerLabel}
            </p>
            <p className="mt-2 text-base font-medium leading-relaxed text-foreground">{question}</p>
          </div>
        </div>

        <TutorQaAnswerOutline
          ref={ref}
          bullets={bullets}
          qaBulletRefs={qaBulletRefs}
          answerBulletIndex={answerBulletIndex}
          answerVisualActive={answerVisualActive}
          fillWhenIdle={fillAnswerOutlineWhenIdle}
        />
      </div>
    );
  },
);
