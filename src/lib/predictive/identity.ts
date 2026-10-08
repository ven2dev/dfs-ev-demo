import type { Membership, Schedule } from "./types.ts";
import { instant } from "./validation.ts";

// Membership is dated source evidence, never proof of participation. Raw team
// aliases must agree with the selected schedule's version of the bridge.
export function applicableQuarterback(membership: Membership, game: Schedule): boolean {
  return membership.position === "QB" &&
    [game.homeTeamId, game.awayTeamId].includes(membership.teamId) &&
    membership.rawTeam === (membership.teamId === game.homeTeamId ? game.rawHomeTeam : game.rawAwayTeam) &&
    instant(membership.effectiveFrom) <= instant(game.kickoff) &&
    instant(membership.effectiveTo) > instant(game.kickoff);
}
