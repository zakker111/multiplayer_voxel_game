import { relativeBearingDegrees, type Position } from './types';

/** Where this team's spotting post is, relative to the local player. */
export interface SpotPostCoverage {
  /** Ground distance from the player, in metres. */
  distance: number;
  /** Bearing relative to the view: 0 ahead, +90 right, +/-180 behind. */
  bearing: number;
}

/** The parts of a placed emplacement the HUD coverage picker needs. */
interface SpotPostLike {
  kind: string;
  team: 'red' | 'blue';
  position: Position;
  /** Destroyed posts smoke but no longer spot. */
  wreck?: boolean;
}

/**
 * Pick this team's spotting post and express where it is for the HUD.
 * A team fields at most one post; if the list carries more, the first own post
 * wins. Enemy posts and other builds are ignored.
 */
export function spotPostCoverage(
  posts: Iterable<SpotPostLike>,
  team: 'red' | 'blue',
  player: Position,
  forward: { x: number; z: number },
): SpotPostCoverage | null {
  for (const post of posts) {
    if (post.wreck || post.kind !== 'spottingPost' || post.team !== team) continue;
    return {
      distance: Math.round(Math.hypot(post.position.x - player.x, post.position.z - player.z)),
      bearing: Math.round(relativeBearingDegrees(player, forward, post.position)),
    };
  }
  return null;
}
