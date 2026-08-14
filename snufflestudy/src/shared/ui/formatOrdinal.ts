// Shared by CompletionScreen.tsx and AbandonedScreen.tsx for their "This is your Nth session…"
// counts. Handles the 11th/12th/13th irregular case (not 11st/12nd/13rd).
export function formatOrdinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;

  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}
