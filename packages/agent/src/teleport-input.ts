import { z } from "zod";

/**
 * Body of POST /api/instances/:id/teleport.
 *
 * PalDefender UserIds are "<platform>_<id>": steam_7656…, xbox_…, and "mac_A:_<hash>" for Mac
 * clients — that last form contains a colon, so ":" must be allowed. The values are interpolated
 * into an RCON command line, so the character sets stay strict: no whitespace in an id, and no
 * newline, quote or shell/command separators anywhere.
 */
export const TeleportBodySchema = z.object({
  source: z.string().trim().regex(/^[A-Za-z0-9_:]+$/).max(128),
  // 目標:玩家 UserId 或座標「x y [z]」(允許數字、負號、小數、空白)。
  target: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9_.:\- ]+$/),
});
