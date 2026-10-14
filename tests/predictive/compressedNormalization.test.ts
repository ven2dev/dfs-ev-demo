import { expect, it } from "vitest";
import { COMPRESSED_SOURCE_NORMALIZATION_VERSION, planSourceStatsNormalization, SOURCE_NORMALIZATION_VERSION, sourceNormalizationBasis } from "../../src/lib/predictive/sourceNormalization.ts";
import { COMPRESSED_SOURCE_PROFILE_VERSION } from "../../src/lib/predictive/compressedPublication.ts";
import { canonical, digest } from "../../src/lib/predictive/validation.ts";
import { compressedNormalizationFixture } from "./fixtures/compressedNormalization.ts";
import { NORMALIZATION_ACCESS, NORMALIZATION_GAME, normalizationFixture, rewriteNormalizationRows } from "./fixtures/sourceNormalization.ts";
import { planSourceBindingTransition, sourceStatsRawKey } from "../../src/lib/predictive/sourceLineage.ts";
import { SOURCE_PROFILE_VERSION } from "../../src/lib/predictive/sourceAdapters.ts";

it.each([2025,2026] as const)("plans compressed %s player claims with exact publication and native witnesses",async season=>{
  const {replay,context}=await compressedNormalizationFixture(season);
  const plan=planSourceStatsNormalization(replay,context,NORMALIZATION_ACCESS,COMPRESSED_SOURCE_NORMALIZATION_VERSION);
  expect(plan.status).toBe("planned-source-normalization");
  expect(plan.candidate?.data).toMatchObject({gameId:NORMALIZATION_GAME,rawGameId:`${season}_06_CAR_PHI`,season,teamId:"nfl:team:PHI",playerId:"00-0000001",passingYards:-2,attempts:10,carries:null});
  expect(plan.binding.parserVersion).toBe(COMPRESSED_SOURCE_PROFILE_VERSION);
  expect(plan.binding.sourcePublications).toEqual(replay.evidence.publications);
  expect(plan.binding.dependencies.map(row=>row.observationId).sort()).toEqual(["game-map","game-schedule","opponent-map","player-map","team-map"]);
  expect(plan.binding.identityLinks.map(row=>row.id)).toEqual(["raw-stats-gsis-link"]);
  expect(plan).toMatchObject({observationsPublished:false,featuresPublished:false,labelsFinalized:false});
  expect(plan.planDigest).toBe(digest(canonical({reason:plan.reason,candidate:plan.candidate,binding:plan.binding})));
});

it("normalizes team claims without inventing a player identity or completion decision",async()=>{
  const {replay,context}=await compressedNormalizationFixture(2025,"team");
  const plan=planSourceStatsNormalization(replay,context,NORMALIZATION_ACCESS,COMPRESSED_SOURCE_NORMALIZATION_VERSION);
  expect(plan.candidate?.kind).toBe("team-game-stats");expect(plan.candidate?.data).not.toHaveProperty("playerId");
  expect(plan.binding.identityLinks).toEqual([]);expect(plan.binding.decisions).toEqual([]);
});

it("requires explicit compressed version compatibility and preserves released text plans",async()=>{
  const {replay,context}=await compressedNormalizationFixture();
  expect(()=>planSourceStatsNormalization(replay,context,NORMALIZATION_ACCESS)).toThrow("source-normalization-evidence-refused");
  const legacy=await normalizationFixture();
  expect(()=>planSourceStatsNormalization(legacy.source,legacy.context,NORMALIZATION_ACCESS,COMPRESSED_SOURCE_NORMALIZATION_VERSION)).toThrow("source-normalization-evidence-refused");
  const plan=planSourceStatsNormalization(legacy.source,legacy.context,NORMALIZATION_ACCESS);
  expect(plan.binding.version).toBe(SOURCE_NORMALIZATION_VERSION);expect(plan.binding).not.toHaveProperty("sourcePublications");
});

it.each(["missing","wrong-capture","late","wrong-format","wrong-season"])("refuses rehashed incompatible publication evidence (%s)",async mode=>{
  const {replay,context}=await compressedNormalizationFixture();
  if(mode==="missing")replay.evidence.publications=[];
  if(mode==="wrong-capture")replay.evidence.publications[0].captureId="another-capture";
  if(mode==="late")replay.evidence.publications[0].recordedAt=NORMALIZATION_ACCESS;
  if(mode==="wrong-format")replay.evidence.captures[0].storageRef=replay.evidence.captures[0].sha256+".csv";
  if(mode==="wrong-season")replay.evidence.rows[0].projection!.season=2026;
  replay.inputDigest=digest(canonical(replay.evidence));
  expect(()=>planSourceStatsNormalization(replay,context,NORMALIZATION_ACCESS,COMPRESSED_SOURCE_NORMALIZATION_VERSION)).toThrow();
});

it.each(["bridge","link","schedule"])("keeps missing or incompatible native %s evidence unavailable",async mode=>{
  const {replay,context,bridgeRows}=await compressedNormalizationFixture();
  if(mode==="bridge")rewriteNormalizationRows(context,bridgeRows.filter(row=>row.id!=="game-map"));
  if(mode==="link")context.identityLinks=[];
  if(mode==="schedule") {const row=bridgeRows.find(row=>row.kind==="schedule")!;row.data.week=5;rewriteNormalizationRows(context,bridgeRows);}
  const plan=planSourceStatsNormalization(replay,context,NORMALIZATION_ACCESS,COMPRESSED_SOURCE_NORMALIZATION_VERSION);
  expect(plan.candidate).toBeNull();expect(plan.reason).toBe(mode==="bridge"?"game-bridge-missing":mode==="link"?"player-bridge-link-missing":"source-schedule-context-conflict");
  expect(plan.binding.sourcePublications).toEqual(replay.evidence.publications);
});

it("binds seals into freshness and refuses current rights while leaving genuine missing source unavailable",async()=>{
  const {replay,context,input}=await compressedNormalizationFixture();
  const before=planSourceStatsNormalization(replay,context,NORMALIZATION_ACCESS,COMPRESSED_SOURCE_NORMALIZATION_VERSION);
  replay.evidence.publications[0].claimsSha256="0".repeat(64);replay.inputDigest=digest(canonical(replay.evidence));
  const changed=planSourceStatsNormalization(replay,context,NORMALIZATION_ACCESS,COMPRESSED_SOURCE_NORMALIZATION_VERSION);
  expect(sourceNormalizationBasis(changed)).not.toBe(sourceNormalizationBasis(before));
  context.rightsDecisions.push({...input.rightsDecisions[0],id:"revoked",predecessorId:input.rightsDecisions[0].id,allowedUses:[],effectiveFrom:"2026-10-11T00:00:00.000Z",decidedAt:"2026-10-11T00:00:00.000Z"});
  expect(planSourceStatsNormalization(replay,context,NORMALIZATION_ACCESS,COMPRESSED_SOURCE_NORMALIZATION_VERSION).reason).toBe("rights-not-in-force");
  context.rightsDecisions.pop();replay.status="unavailable-source-claim";replay.reason="source-row-missing";replay.evidence.rows=[];replay.inputDigest=digest(canonical(replay.evidence));
  expect(planSourceStatsNormalization(replay,context,NORMALIZATION_ACCESS,COMPRESSED_SOURCE_NORMALIZATION_VERSION)).toMatchObject({reason:"source-row-missing",candidate:null});
});

it("accepts explicit multi-season compressed lineage while refusing a rehashed legacy parser downgrade",async()=>{
  const {replay,context}=await compressedNormalizationFixture();
  const plan=planSourceStatsNormalization(replay,context,NORMALIZATION_ACCESS,COMPRESSED_SOURCE_NORMALIZATION_VERSION);
  const transition=planSourceBindingTransition(plan,[],NORMALIZATION_ACCESS);
  expect(transition.action).toBe("append");expect(transition.candidate?.data).toMatchObject({season:2025,passingYards:-2});
  expect(sourceStatsRawKey(plan.binding.sourceRequest)).toBe(digest(canonical(["2025_06_CAR_PHI","PHI","00-0000001"])));
  const downgraded=structuredClone(plan);downgraded.binding.version=SOURCE_NORMALIZATION_VERSION;downgraded.binding.parserVersion=SOURCE_PROFILE_VERSION;
  Reflect.deleteProperty(downgraded.binding,"sourcePublications");downgraded.planDigest=digest(canonical({reason:downgraded.reason,candidate:downgraded.candidate,binding:downgraded.binding}));
  expect(()=>planSourceBindingTransition(downgraded,[],NORMALIZATION_ACCESS)).toThrow("source-lineage-plan-refused");
});
