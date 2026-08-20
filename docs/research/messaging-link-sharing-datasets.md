# Messaging-platform link-sharing data

Research date: 2026-08-16

## Bottom line

Messaging platforms do **not** appear to publish a current, platform-wide ranking of the destination domains or URLs people send. The best directly useful public evidence is narrower:

1. A 2025 Telegram public-group study publishes actual domain counts and per-topic shares.
2. A small 2018 WhatsApp public-group dataset exposes a `media url` field.
3. DISCO exposes the text of 1.5 million messages from four programming Discord channels, so URLs can be extracted, but it is an extremely narrow sample.
4. The much larger Discord Unveiled release included message text, but its repository record was deleted for containing personal data.

Slack, Teams, Messenger, and Matrix provide owner-/tenant-/room-scoped ways to obtain messages; none provides a public cross-platform destination distribution. Bitly has excellent data, but its public API and dashboards expose only links belonging to the authenticated account or group, not a global corpus.

## Source comparison

| Source | Actual destination frequency or URL data? | Access / rights | Fit for URL-model training |
|---|---|---|---|
| **Telegram: Topic-wise Exploration of the Telegram Group-verse** | **Yes.** Figure 6 reports counts and per-topic shares for external domains. Across the sample, `youtube.com` appears 128,397 times and makes up 8.1% of unique shared links; the other reported domains include X, Instagram, Google Play/Docs/Forms, Bitly, Discord, GitHub, Facebook, VK, TikTok, WhatsApp, and others. | The authors' public GitHub repository provides a 12.7 MB sample and says the full dataset is available on request. It has no repository-level license. The anonymous review artifact cited by the paper has expired. | **Best published weighting evidence.** It covers 51.7M messages from 669 large, active public groups over two months, but sampling began with TGStat's popular groups and is heavily affected by spam/repetition. Use de-duplicated URL or per-group weighting, not raw message counts. [[sample and crawler](https://github.com/aleperlo/TopicWiseTelegram)] [[paper](https://iris.polito.it/retrieve/handle/11583/3000482/f09f4aa2-5235-406c-b62f-5de7f3da6541/3701716.3717506.pdf)] |
| **WhatsApp, Doc?** | **Yes, small-scale.** The public TSV omits message text but explicitly includes a `media url` field plus fetched page title and snippet. | Public GitHub download; repository says research purposes only and gives no standard open-data license. Full message content requires emailing the authors. | **Usable after legal/ethical review.** Roughly 300K released messages from 178 discoverable public groups over about five months. Strong public-group and 2017-era selection bias; not representative of private chats. [[dataset/readme](https://github.com/gvrkiran/whatsapp-public-groups)] [[paper](https://ojs.aaai.org/index.php/ICWSM/article/view/14989)] |
| **DISCO (Discord)** | **Yes, indirectly.** The XML retains message text, so literal URLs can be extracted. It contains 1,508,093 utterances in 28,712 conversations. | The 103 MB archive remains downloadable from Zenodo. Zenodo displays no explicit license; the paper frames the release as up to 10% of copyrighted chat data under the authors' university fair-dealing policy. | **Useful niche validation set, not a general prior.** It is one year (2019–2020) from only four software-development help channels: Python, Go, Racket, and Clojure. [[dataset](https://zenodo.org/records/5909202)] [[paper](https://soar-lab.github.io/papers/DISCO.pdf)] |
| **Discord Unveiled** | The paper describes JSON message records from 2.05B messages, 4.74M users, and 3,167 Discovery servers; the message schema includes message content. | The official Zenodo record was deleted on 2025-05-27 with removal reason `personal-data`. A public, ungated 118 GB Hugging Face mirror remains online, but it is uploader-maintained rather than an official replacement for the withdrawn record. | Technically the strongest Discord corpus. If accepted for internal URL-only processing, preserve the tombstone/provenance warning, discard message text and identifiers immediately, and do not redistribute the raw corpus. Its Discovery-server sample still omits private and small non-Discovery servers and includes bots. [[paper](https://arxiv.org/abs/2502.00627)] [[Zenodo tombstone](https://zenodo.org/api/records/15170676)] [[mirror](https://huggingface.co/datasets/SaisExperiments/Discord-Unveiled-Compressed)] |
| **TGDataset (Telegram)** | **No in the released corpus, by design.** It has 498,320,597 messages from 120,979 public broadcast channels, but the authors state that links were excluded from the public dataset. | Four downloadable JSON archives totaling 70.7 GB on Zenodo. The record is open; its API metadata declares `cc-by-4.0` even though the current HTML rights field renders blank. | Valuable for host-independent text/token context, but **not directly usable for destination frequencies**. It is also broadcast-channel data discovered by forwarding from 180 seed channels, not conversational/private messaging. [[dataset](https://zenodo.org/records/7640712)] [[paper](https://arxiv.org/abs/2303.05345)] |
| **Slack exports** | Only for a workspace the requester administers. Public-channel exports contain message history in JSON; broader exports can include private channels and DMs after the appropriate application/plan/legal basis. | Workspace/organization owner access; retention and plan limits apply. Slack explicitly ties all-conversation exports to consent, valid legal process, or applicable-law rights. | **Good only for a consented first-party workspace.** There is no Slack-wide aggregate or public destination feed. [[official export guide](https://slack.com/help/articles/201658943-Export-your-workspace-data)] [[export format](https://slack.com/help/articles/220556107-How-to-read-Slack-data-exports)] |
| **Microsoft Teams export API** | Only for an organization's tenant. The Graph export APIs return chat and channel message bodies and attachments. | Requires an active Teams license and administrator-approved application permissions such as `Chat.Read.All` and `ChannelMessage.Read.All`. | **Good only for a consented tenant**, likely biased toward workplace links. Microsoft publishes work-trend studies but not a domain-frequency table. [[official API guide](https://learn.microsoft.com/en-us/microsoftteams/export-teams-content)] |
| **Messenger / WhatsApp private messaging** | No platform-wide content feed. Both products protect personal message content with end-to-end encryption; Meta says it cannot read the content unless a participant reports it. | User-side exports or opt-in research are the realistic route. | A platform-produced global destination table would be structurally incompatible with the stated privacy model. Facebook's research URL dataset is a useful **Facebook-feed proxy**, but explicitly concerns Facebook URLs, not Messenger. [[WhatsApp encryption](https://about.fb.com/news/2025/01/whatsapp-joins-accounts-center/)] [[Messenger encryption](https://about.fb.com/news/2023/12/default-end-to-end-encryption-on-messenger/)] [[Facebook URL dataset](https://socialscience.one/blog/unprecedented-facebook-urls-dataset-now-available-research-through-social-science-one)] |
| **Matrix** | No known packaged link-frequency dataset. The protocol exposes a public-room directory and paginated room messages, but message history requires authentication; most rooms require joining, and `world_readable` is a distinct history setting. | Federated, room-scoped access; room-directory visibility does not imply world-readable history. Encryption and homeserver/room policies further limit coverage. | Technically collectible from explicitly world-readable or consented rooms, but there is no representative global sample. [[Matrix Client-Server API](https://spec.matrix.org/latest/client-server-api/)] [[Matrix explanation of room visibility](https://matrix.org/blog/2023/07/what-happened-with-the-archive/)] |
| **Bitly (proxy)** | Bitly can reveal a destination and engagement for links in an authenticated account/group. Public docs expose group lists, long URLs, clicks, referrers, and top-performing links, but **not global destination rankings** across customers. | Account token required; history and metrics depend on subscription plan. | A useful **opt-in telemetry proxy** if users connect their own Bitly groups. It is marketing-heavy and measures created/clicked shortened links, not all links pasted into chats. [[API reference](https://dev.bitly.com/api-reference/)] [[metrics guide](https://dev.bitly.com/docs/tutorials/retrieve-metrics/)] |

## Acquisition manifest

Verified on 2026-08-16 against the upstream repository APIs and publisher pages. Sizes below are exact bytes when the upstream API exposes them; GB values elsewhere on the pages are decimal. Dataset checksums are upstream-published unless explicitly described otherwise. Report SHA-256 values were locally verified from the linked file on the research date. A GitHub blob ID is an integrity identifier for a Git object, not a conventional checksum of the raw file bytes.

### Telegram Group-verse

- **Author repository:** [`aleperlo/TopicWiseTelegram`](https://github.com/aleperlo/TopicWiseTelegram), pinned commit `f0c45aafcfcad99dd7844352df466eb915cd3c2f`.
- **Public sample:** [`sample/sample.zip`](https://raw.githubusercontent.com/aleperlo/TopicWiseTelegram/f0c45aafcfcad99dd7844352df466eb915cd3c2f/sample/sample.zip), 12,726,728 bytes; Git blob ID `ef3c773e1e26d070fb859ae4ee77b04137424c72`. It contains the first 10,000 messages from one randomly sampled group in each topic.
- **Full corpus:** request-only. The repository README says the full dataset will be released on request because of its sensitivity; no public size, checksum, license, or request form is provided. Contact the paper authors.
- **License:** no repository-level license is declared. Do not infer a dataset license from the paper's publication license.
- **Expired artifact:** the paper's `https://anonymous.4open.science/r/TopicWiseTelegram-7A81` landing shell still answers, but both `/api/repo/TopicWiseTelegram-7A81/files/` and `/api/repo/TopicWiseTelegram-7A81/zip` return HTTP 410 with `{"error":"repository_expired"}`.
- **Report:** [arXiv v2 PDF](https://arxiv.org/pdf/2409.02525), 4,842,871 bytes, locally verified SHA-256 `56318ea9298572e60b6e75ee3644dd8a3f81c6f29c1db414684c4062b464e122`; [publisher-author repository PDF](https://iris.polito.it/retrieve/handle/11583/3000482/f09f4aa2-5235-406c-b62f-5de7f3da6541/3701716.3717506.pdf).

### WhatsApp, Doc?

- **Dataset file:** [`anonymised_data_to_share.tsv`](https://raw.githubusercontent.com/gvrkiran/whatsapp-public-groups/1d6d71d1a39434f12610fba8791461395fbbff29/anonymised_data_to_share.tsv), pinned at repository commit `1d6d71d1a39434f12610fba8791461395fbbff29`.
- **Size and integrity:** 43,914,511 bytes; Git blob ID `29e7ce0eced2ab3f997c67fb0e5cb1e60addcaf3`. No conventional checksum is published.
- **Access and rights:** public, but the repository has no root license and its README limits the collection and released data to research purposes. The GPL file inside `WhatsApp-Crypt12-Decrypter/` applies to that imported tool, not automatically to the dataset.
- **Content:** over 300,000 anonymized rows, including `media url`, fetched page title, snippet, group ID, timestamp, and aggregate message metadata. Original message text is not public and is available to researchers only by contacting the authors.
- **Supplemental group-seed list:** [`whatsapp_group_links.txt`](https://raw.githubusercontent.com/gvrkiran/whatsapp-public-groups/1d6d71d1a39434f12610fba8791461395fbbff29/whatsapp_group_links.txt), 179,641 bytes; Git blob ID `021855115540bc1be7b0d3fc1e7100d09e59a1ad`. It mostly preserves discovered `chat.whatsapp.com` invitations and is not destination-frequency training data.
- **Report:** [AAAI article page](https://ojs.aaai.org/index.php/ICWSM/article/view/14989) and [official PDF](https://ojs.aaai.org/index.php/ICWSM/article/download/14989/14839), 1,033,658 bytes, locally verified SHA-256 `1af6f05930eb086b176a0dbf9de62c7ffff48b450075ddbc173e4e0c0590dd1a`. An [author-hosted copy](https://users.ics.aalto.fi/kiran/content/whatsapp.pdf) is also available.

### DISCO

- **Dataset file:** [`DISCO-A Dataset of Discord Chat Conversations for Software Engineering Research.zip`](https://zenodo.org/api/records/5909202/files/DISCO-A%20Dataset%20of%20Discord%20Chat%20Conversations%20for%20Software%20Engineering%20Research.zip/content).
- **Size and checksum:** 102,955,559 bytes; MD5 `058bc2c632e038050e8eb4e24a523e91`, published by Zenodo.
- **Record and rights:** [Zenodo record 5909202](https://zenodo.org/records/5909202), DOI `10.5281/zenodo.5909202`. The current Zenodo API classifies the license as `other-open`, but neither the record page nor metadata supplies actual standard license terms; retain that ambiguity with the artifact.
- **Report:** [author-lab PDF](https://soar-lab.github.io/papers/DISCO.pdf), 656,627 bytes, locally verified SHA-256 `8521238ab780cc2d42dde889e9238b0c54ec171f83b34f77ed07ae47d57a4b15`; paper DOI `10.1145/3524842.3528018`.

### Discord Unveiled

- **Official record status:** [Zenodo record 15170676](https://zenodo.org/api/records/15170676) returns HTTP 410. Its tombstone says it was removed on `2025-05-27T14:25:28.671004` for `personal-data`. There is no current official corpus download.
- **Public mirror:** [`dataset.zst`](https://huggingface.co/datasets/SaisExperiments/Discord-Unveiled-Compressed/resolve/3d3053f1b951617a5b560c0025affc6261b6ffe1/dataset.zst?download=true), pinned at Hugging Face repository revision `3d3053f1b951617a5b560c0025affc6261b6ffe1`.
- **Size and checksum:** 117,962,356,699 bytes (117.962 GB / 109.861 GiB); SHA-256 `0196416253fab4bce08504737bc81215927d9afdc6ccc81f75345518109266a4`, reported in the Hugging Face LFS/Xet metadata.
- **Access and rights:** the mirror is currently public and ungated and its uploader declares `cc-by-4.0`. That is a mirror-side declaration, not evidence that Zenodo reversed the takedown or that the mirror uploader controls all privacy and third-party message rights. Preserve the tombstone and mirror metadata beside any internal copy.
- **Report:** [arXiv paper](https://arxiv.org/abs/2502.00627) and [direct PDF](https://arxiv.org/pdf/2502.00627), 1,075,744 bytes, locally verified SHA-256 `76b52b58c7fe35e1da90f34943423819a292f4ba9fd3f06dd4975ab28b6f9866`. The paper itself is CC BY 4.0; that does not settle rights in the message corpus.

### TGDataset

- **Record:** [Zenodo record 7640712](https://zenodo.org/records/7640712), DOI `10.5281/zenodo.7640712`. The API metadata declares `cc-by-4.0`; the current HTML page's license field is blank.
- **Total:** 70,696,037,533 bytes (70.696 GB / 65.841 GiB) across four archives:
  - [`TGDataset_1.tar.gz`](https://zenodo.org/api/records/7640712/files/TGDataset_1.tar.gz/content) — 19,713,507,083 bytes; MD5 `4309e8bc3db05d95dd870092631fb90e`.
  - [`TGDataset_2.tar.gz`](https://zenodo.org/api/records/7640712/files/TGDataset_2.tar.gz/content) — 20,438,012,013 bytes; MD5 `83e5b3bf47501294496c76befb4991f3`.
  - [`TGDataset_3.tar.gz`](https://zenodo.org/api/records/7640712/files/TGDataset_3.tar.gz/content) — 21,051,491,206 bytes; MD5 `42b02ec675b2153d800cad3f4ae869f0`.
  - [`TGDataset_4.tar.gz`](https://zenodo.org/api/records/7640712/files/TGDataset_4.tar.gz/content) — 9,493,027,231 bytes; MD5 `d2c7c4bb84d745c58f8e04c1730f1758`.
- **URL-training caveat:** the released messages exclude links, so downloading all 70.7 GB will not add host/TLD frequency evidence. Acquire it only for host-independent token/context experiments.
- **Report:** [arXiv paper](https://arxiv.org/abs/2303.05345) and [direct PDF](https://arxiv.org/pdf/2303.05345), 1,158,787 bytes, locally verified SHA-256 `b1fa4d1f7cf30b733059a14aad7e7dae47daaf4f39d4ec11eb9060c2b3c31aa2`. The proceedings DOI is `10.1145/3690624.3709397`.

### Bitly studies: reports only

No public raw trace was located for these papers. Their reported Bitly datasets were collected for the individual studies, not released as downloadable corpora, and the current Bitly API exposes only authenticated account/group data.

- **Bit.ly/practice** — 80 million URLs and 4.2 billion requests. [DOI/publisher page](https://doi.org/10.1016/j.tele.2018.03.003); [institutional repository PDF](https://arodes.hes-so.ch/record/2798/files/Robert_2018_Bitly_practice.pdf), 1,179,661 bytes, locally verified SHA-256 `6056fcea7f05d6690123a09c2048c1b6575c5626384ab5186d8b3d929ac1628b`. Publisher copyright is Elsevier 2018; no dataset license, file, size, or checksum is published.
- **we.b: The web of short URLs** — traces include 7,401,026 Bitly URLs with 2,202,442,600 accesses plus smaller Bitly, Twitter, and `ow.ly` samples. [Microsoft Research record](https://www.microsoft.com/en-us/research/publication/we-b-the-web-of-short-urls/) and [Microsoft-hosted PDF](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/p715.pdf), 1,753,807 bytes, locally verified SHA-256 `cbb08b8cbd0224030e43959e07cfccca14ab268a8bbc4c73e7f33feb162fdd90`; DOI `10.1145/1963405.1963505`. No raw trace or checksum is published.
- **bit.ly/malicious** — 763,160 Bitly URLs marked suspicious in October 2013. [arXiv paper](https://arxiv.org/abs/1406.3687) and [direct PDF](https://arxiv.org/pdf/1406.3687), 931,192 bytes, locally verified SHA-256 `eaf2eb44cf36f176bda01080afcaef35f7c0b3d6f8c519f10096e136e4b28993`. No raw dataset file, size, checksum, or dataset license is published.

The known public data downloads above total 188,817,991,030 bytes (188.818 GB / 175.850 GiB), dominated by Discord Unveiled and TGDataset. Excluding TGDataset, which contains no links, the URL-relevant public downloads total about 118.122 GB before any reports.

## Practical recommendation

For the current weighting pass:

- Use the Telegram study's **unique-link** evidence as a bounded messaging prior, with YouTube clearly first and X/Instagram next; preserve its per-topic variation rather than treating it as a universal platform ranking.
- Download and inspect **DISCO** and **WhatsApp, Doc?** as small held-out corpora. Count both raw occurrences and unique normalized URLs per conversation/group, and report bot/duplicate sensitivity.
- Do not treat TGDataset as a link corpus. If the Discord Unveiled mirror is accepted for internal processing, stream-extract only URLs and coarse source context, discard message text and identifiers immediately, and keep the withdrawal/provenance record beside the derived aggregates.
- If first-party data becomes possible, the cleanest path is a consented Slack/Teams/Discord community export or client-side, privacy-preserving aggregation from real piss.zip usage. Keep query values and fragments out of telemetry, publish only thresholded aggregate counts, and separate private messaging from public/broadcast channels.

The major representativeness warning is that all public academic corpora over-sample public groups, channels, large communities, bots, spam, politics, crypto, and software support. They are evidence about *public messaging*, not about links in ordinary private conversations.
