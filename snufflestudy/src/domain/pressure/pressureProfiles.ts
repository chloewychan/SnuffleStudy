export interface PressureProfile {
  id: string;
  name: string;
  intensity: "gentle" | "moderate" | "ruthless";
  description: string;
  firstWarningMessages: string[];
  repeatedWarningMessages: string[];
  breakMessages: string[];
  completionMessages: string[];
  abandonmentMessages: string[];
  animationLevel: "low" | "medium" | "high";
  allowFriendNudges: boolean;
  requireUnlockApproval: boolean;
  maxNudgesPerSession: number;
}

export const PRESSURE_PROFILES: PressureProfile[] = [
  {
    id: "gentle-encouragement",
    name: "Gentle Encouragement",
    intensity: "gentle",
    description: "Warm, supportive nudges. No judgment.",
    firstWarningMessages: ["Hey, is this part of the plan?", "Just checking in — still studying?"],
    repeatedWarningMessages: ["I believe in you. Let's head back?", "No pressure, but your goal is waiting."],
    breakMessages: ["Good work. Rest a little.", "You earned this break."],
    completionMessages: ["You did it! Proud of you.", "Goal complete. Nice work."],
    abandonmentMessages: ["That's okay. Try again soon.", "No shame — reschedule when ready."],
    animationLevel: "low",
    allowFriendNudges: true,
    requireUnlockApproval: false,
    maxNudgesPerSession: 3,
  },
  {
    id: "strict-coach",
    name: "Strict Coach",
    intensity: "moderate",
    description: "Firm, direct, no-nonsense accountability.",
    firstWarningMessages: ["That's not on your list. Back to work.", "Off task. Fix it."],
    repeatedWarningMessages: ["This is the second time. Focus.", "You committed to this. Follow through."],
    breakMessages: ["Break's on the clock. Use it well.", "Recharge, then back at it."],
    completionMessages: ["Goal complete. That's how it's done.", "Solid session. Keep this up."],
    abandonmentMessages: ["Session ended early. Note why, and try again.", "Not today. Reset and go again."],
    animationLevel: "medium",
    allowFriendNudges: true,
    requireUnlockApproval: true,
    maxNudgesPerSession: 5,
  },
  {
    id: "ruthless-roaster",
    name: "Ruthless Roaster",
    intensity: "ruthless",
    description: "Theatrically merciless. Loud, funny, relentless.",
    firstWarningMessages: ["That is NOT chemistry.", "Caught you. Already."],
    repeatedWarningMessages: ["Again? Really?", "Your goals are watching you fail right now."],
    breakMessages: ["Fine. Five minutes. I'm timing you.", "Break granted. Don't get comfortable."],
    completionMessages: ["...okay, that was actually impressive.", "Goal complete. I'm shocked too."],
    abandonmentMessages: ["Wow. Okay. We'll talk about this later.", "Abandoned. Your friends will hear about this."],
    animationLevel: "high",
    allowFriendNudges: true,
    requireUnlockApproval: true,
    maxNudgesPerSession: 8,
  },
  {
    id: "parent-mode",
    name: "Parent Mode",
    intensity: "moderate",
    description: "Caring but exasperated. Classic parent energy.",
    firstWarningMessages: ["Is this really what you should be doing right now?", "I'm not mad, just... focus."],
    repeatedWarningMessages: ["We talked about this.", "I raised you better than this tab."],
    breakMessages: ["Fine, take a break. Drink some water.", "Okay, five minutes. Set a timer."],
    completionMessages: ["I'm so proud of you.", "See? You could do it all along."],
    abandonmentMessages: ["It's fine. We'll try again later.", "Okay. Rest, then come back to it."],
    animationLevel: "medium",
    allowFriendNudges: true,
    requireUnlockApproval: true,
    maxNudgesPerSession: 5,
  },
  {
    id: "hype-squad",
    name: "Hype Squad",
    intensity: "moderate",
    description: "Loud, energetic, relentlessly positive.",
    firstWarningMessages: ["LET'S GO. BACK TO IT.", "Nuh uh. Not today. Refocus!"],
    repeatedWarningMessages: ["You've GOT this. Come on!", "One more unapproved tab and we riot (positively)."],
    breakMessages: ["BREAK TIME. You EARNED it!", "Stretch! Hydrate! Let's gooo!"],
    completionMessages: ["YOU DID THAT.", "GOAL. COMPLETE. LEGENDARY."],
    abandonmentMessages: ["It's not over, it's a plot twist. Try again!", "We regroup and come back stronger!"],
    animationLevel: "high",
    allowFriendNudges: true,
    requireUnlockApproval: false,
    maxNudgesPerSession: 6,
  },
  {
    id: "silent-enforcement",
    name: "Silent Enforcement",
    intensity: "ruthless",
    description: "No commentary. Just strict, quiet enforcement.",
    firstWarningMessages: ["Unapproved site.", "Off task."],
    repeatedWarningMessages: ["Still off task.", "Return to your session."],
    breakMessages: ["Break started.", "Break active."],
    completionMessages: ["Goal complete.", "Session complete."],
    abandonmentMessages: ["Session ended.", "Session abandoned."],
    animationLevel: "low",
    allowFriendNudges: false,
    requireUnlockApproval: true,
    maxNudgesPerSession: 0,
  },
];

export function getPressureProfile(id: string): PressureProfile {
  const profile = PRESSURE_PROFILES.find((p) => p.id === id);
  if (!profile) throw new Error(`Unknown pressure profile: ${id}`);
  return profile;
}
