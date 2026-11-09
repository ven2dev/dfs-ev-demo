# #53 public-serving roadmap addendum

Draft for review. This addendum applies to the participation-derived serving
scope of #53. It builds on the existing #53 product contract and the #54
model-validation gate. [#53](https://github.com/ven2dev/dfs-ev-demo/issues/53)

## Release prerequisite

**#197 is a prerequisite for public delivery of any participation-derived
#53 output.** Before release, each enabled response field, UI presentation,
download or published artifact needs an approved disposition tied to the
exact output and its source lineage. The public path must fail closed when
the disposition is missing, unresolved, stale, withdrawn or mismatched. This
prevents the existing research authorization from granting a public release.
Independently sourced outputs may proceed under their own qualified lineage
and approvals. [#197 roadmap](197-roadmap.md)

## Enforcement test matrix

| Case | Expected result |
| --- | --- |
| Participation-derived output with missing or unresolved disposition, even with a valid research receipt | API emits a typed unavailable state. UI, downloads and artifact publishing omit the affected content. |
| Approved version, output and channel with current source lineage and rights | Deliver only the approved fields through the approved channel with its required credits, license links and modification notices. |
| New source snapshot, model, output version or distribution channel outside the approval | Refuse the affected output until its changed scope is approved. |
| Approval or source right withdrawn after private calculation | Withhold affected data at delivery. Cache, refresh and fallback paths cannot revive the prior result. |
| Mixed-source response with participation-derived and independently sourced fields | Withhold the affected fields and dependent values. Preserve only eligible independent fields under their own approvals. |
| API field hidden in the UI or alternate direct request to a download, endpoint or artifact publisher | Enforce the same disposition at the delivery boundary. |
| Case with no participation dependency and valid independent approvals | Deliver the independent result. Missing participation approval has no effect on its eligibility. |
| #241 public fixture has an approved data notice | That approval applies to its listed files. Product forecasts and other channels still require their own disposition. |

Use synthetic lineage controls for these checks. The serving implementation
and its release evidence belong to #53. The inventory, existing public data
notices and disposition decision belong to #197.
