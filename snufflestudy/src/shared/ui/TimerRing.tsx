interface TimerRingProps {
  remainingSeconds: number;
  totalSeconds: number;
}

export function TimerRing({ remainingSeconds, totalSeconds }: TimerRingProps) {
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;
  const progress = totalSeconds > 0 ? remainingSeconds / totalSeconds : 0;

  return (
    <div className="timer-ring" role="timer" aria-live="polite">
      <svg viewBox="0 0 100 100" width="120" height="120">
        <circle cx="50" cy="50" r="45" className="timer-ring__track" />
        <circle
          cx="50"
          cy="50"
          r="45"
          className="timer-ring__progress"
          style={{ strokeDasharray: `${progress * 283} 283` }}
        />
      </svg>
      <span className="timer-ring__label">
        {minutes}:{seconds.toString().padStart(2, "0")}
      </span>
    </div>
  );
}
