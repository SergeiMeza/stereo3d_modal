# 1. Raw depths + 1440p

(A/B test 1): Perceived subjective quality.

| DM Resolution | Quality  | Quality @1440p | cost     | memo                                                                                                 |
| ------------- | -------- | -------------- | -------- | ---------------------------------------------------------------------------------------------------- |
| d714 (720p)   | low (3)  | low (3)        | 0.096012 |                                                                                                      |
| d1078 (1080p) | low (4)  | low (4)        | 0.27745  |                                                                                                      |
| d1442 (1440p) | mid (6)  | mid (6)        | 0.483551 | it was slower and expensier because it used A100-SXM4-80GB                                           |
| d1806 (1800p) | high (7) | high (7)       | 0.466253 | it was faster and cheaper because it used H200 directly                                              |
|               |          | Quality @1800p |          |                                                                                                      |
| d1806 (1800p) | high (7) | high (8)       | 0.59059  | The higher resolution makes the video better overall given the high resolution of the AVP screens    |
|               |          | Quality @2160p |          |                                                                                                      |
| d714 (720p)   | low (3)  | high (5)       | 0.341513 | The quality is good overall but it might be ghosting? Also I don't know how much the 3D effect drops |
| d1078 (1080p) |          |                | 0.424983 |                                                                                                      |
| d1442 (1440p) |          |                | 0.651013 | it was slower and expensier because it used A100-SXM4-80GB                                           |
| d1806 (1800p) |          |                | 0.688456 |                                                                                                      |

# 2. Raw depth at 1440p

(A/B test 1): Perceived subjective quality.

|                   | Test (A) | Test (B)   |
| ----------------- | -------- | ---------- |
| resolution        | 1440p    | 4K         |
| raw depth (1440p) | good (7) | better (9) |
| m2svid (720)      | bad (3)  | meh (5)    |
| propainter (720)  | good (8) | best (10)  |

m2svid introduces allucinations and ghosting. Propainter doesn't.
