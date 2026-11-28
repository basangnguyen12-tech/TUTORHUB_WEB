#!/usr/bin/env node
/**
 * MSG-STICKER-02 (ADR-0047): builds the curated "Noto Animated" sticker pack.
 *
 *   node apps/web/scripts/generate-sticker-catalog.mjs            # build
 *   node apps/web/scripts/generate-sticker-catalog.mjs --check    # verify only
 *   node apps/web/scripts/generate-sticker-catalog.mjs --print-lock
 *
 * Source: Google Noto Emoji Animation (CC BY 4.0,
 * https://googlefonts.github.io/noto-emoji-animation/), whose official assets
 * are served from fonts.gstatic.com. That CDN exposes no immutable tag for
 * every asset, so each 512 px animated WebP is pinned by SHA-256 below; a
 * changed upstream file fails the build closed instead of silently shipping
 * different artwork. `--print-lock` prints fresh digests for a reviewed bump.
 *
 * Output (one source of truth for web and Core API):
 *   apps/web/public/stickers/<pack>/<version>/<codepoint>.webp        160x160 animated, <= 100 KB
 *   apps/web/public/stickers/<pack>/<version>/<codepoint>.static.webp 160x160 representative frame, <= 15 KB
 *   services/core-api/internal/modules/conversation/stickers/catalog.json (go:embed)
 *
 * Transcoding is a build-time step through Python + Pillow (`python -I`), so
 * nothing is added to the web bundle or the Core API runtime. `--check` needs
 * neither the network nor Python: it validates the committed files, the WebP
 * headers, the per-file and total budgets and that catalog.json carries
 * exactly the table below.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(scriptDir, "..");
const repoRoot = resolve(webRoot, "..", "..");
const stickersRoot = join(webRoot, "public", "stickers");
const catalogPath = join(
  repoRoot,
  "services",
  "core-api",
  "internal",
  "modules",
  "conversation",
  "stickers",
  "catalog.json",
);
const noticesPaths = [
  join(repoRoot, "THIRD_PARTY_NOTICES.md"),
  join(webRoot, "public", "THIRD_PARTY_NOTICES.txt"),
];

export const CATALOG_VERSION = "2026-11-28.1";
export const PACK_ID = "noto_animated";
export const PACK_VERSION = "v1";
const SOURCE_BASE = "https://fonts.gstatic.com/s/e/notoemoji/latest";
const SOURCE_SIZE = 512;
const STICKER_SIZE = 160;
const ANIMATED_LIMIT = 100 * 1024;
const ANIMATED_TARGET = 80 * 1024;
const STATIC_LIMIT = 15 * 1024;
const TOTAL_LIMIT = 10 * 1024 * 1024;
const FILE_LIMIT = 300;
const MIN_STICKERS = 80;
const MAX_STICKERS = 120;
/** [frame step, WebP quality] tried in order until a file fits the target. */
const ENCODE_LADDER = [
  [1, 62],
  [2, 62],
  [2, 52],
  [3, 52],
  [3, 44],
  [4, 44],
  [5, 38],
  [6, 34],
];

const PACK = {
  id: PACK_ID,
  version: PACK_VERSION,
  title: { vi: "Biểu cảm Noto", en: "Noto Animated" },
  attribution: {
    text: "Noto Emoji Animation by Google, licensed under CC BY 4.0. Modified by TutorHub: curated subset, resized to 160×160 animated WebP, plus a static representative-frame WebP.",
    license: "CC BY 4.0",
    url: "https://creativecommons.org/licenses/by/4.0/",
    notices_path: "/THIRD_PARTY_NOTICES.txt",
  },
};

/**
 * Curated subset: [codepoint, en label, vi label, en keywords, vi keywords].
 * Order is the picker order (faces, encouragement, hearts, celebration,
 * study). Codepoints follow the upstream file names.
 */
const STICKERS = [
  // Faces
  ["1f600", "Smile", "Cười tươi", "happy smile grin", "vui|cười|vui vẻ"],
  ["1f603", "Big smile", "Cười toe", "happy joy smile", "vui|hớn hở"],
  ["1f604", "Grin", "Cười híp mắt", "happy laugh", "vui|cười"],
  ["1f601", "Beaming", "Cười nhe răng", "grin proud", "tự hào|nhe răng"],
  ["1f606", "Laughing", "Cười lớn", "laugh lol", "cười lớn|haha"],
  ["1f605", "Nervous laugh", "Cười trừ", "sweat awkward phew", "ngại|đổ mồ hôi|hú hồn"],
  ["1f602", "Tears of joy", "Cười ra nước mắt", "lol funny haha", "buồn cười|haha|hài"],
  ["1f923", "Rolling on the floor laughing", "Cười lăn lộn", "rofl lmao funny", "cười bò|hài hước"],
  ["1f60a", "Blush", "Mỉm cười e thẹn", "shy happy pleased", "ngượng|dễ thương"],
  ["1f607", "Angel", "Thiên thần", "halo innocent good", "ngoan|hiền"],
  ["1f642", "Slight smile", "Mỉm cười", "ok fine", "ổn|mỉm cười"],
  ["1f643", "Upside-down face", "Mặt lộn ngược", "silly sarcasm", "lộn ngược|đùa"],
  ["1f609", "Wink", "Nháy mắt", "wink joke", "nháy mắt|đùa"],
  ["1f60d", "Heart eyes", "Mắt trái tim", "love adore", "yêu thích|mê"],
  ["1f970", "Smiling with hearts", "Yêu thương", "love affection", "thương|tình cảm"],
  ["1f618", "Blowing a kiss", "Gửi nụ hôn", "kiss love", "hôn gió|thương"],
  ["1f929", "Star-struck", "Mắt sao", "wow amazing excited", "tuyệt vời|phấn khích"],
  ["1f973", "Partying face", "Tiệc tùng", "party celebrate birthday", "ăn mừng|sinh nhật"],
  ["1f60e", "Cool", "Ngầu", "sunglasses cool", "kính râm|ngầu"],
  ["1f913", "Nerd", "Mọt sách", "nerd geek study smart", "học bá|chăm học|thông minh"],
  ["1f914", "Thinking", "Suy nghĩ", "think hmm question", "suy nghĩ|hmm|thắc mắc"],
  ["1f9d0", "Monocle", "Soi kỹ", "inspect curious check", "kiểm tra|tò mò"],
  ["1f92b", "Shush", "Suỵt", "quiet secret silence", "im lặng|bí mật|trật tự"],
  ["1f917", "Hug", "Ôm", "hug thanks", "ôm|cảm ơn"],
  ["1fae1", "Salute", "Tuân lệnh", "salute yes respect|got it", "rõ|nhận lệnh|vâng"],
  ["1f972", "Smiling with a tear", "Cười trong nước mắt", "touched grateful bittersweet", "cảm động|xúc động"],
  ["1f979", "Holding back tears", "Rưng rưng", "touched moved emotional", "cảm động|rưng rưng"],
  ["1f97a", "Pleading", "Năn nỉ", "please beg|puppy eyes", "năn nỉ|làm ơn|xin"],
  ["1f62d", "Loudly crying", "Khóc to", "cry sad sob", "khóc|buồn"],
  ["1f622", "Crying", "Rơi nước mắt", "sad tear", "buồn|khóc"],
  ["1f614", "Pensive", "Trầm ngâm", "sad sorry regret", "buồn|tiếc|xin lỗi"],
  ["1f62e", "Open mouth", "Ngạc nhiên", "surprised oh", "bất ngờ|ồ"],
  ["1f631", "Screaming", "Hét lên", "scared shocked omg", "sợ hãi|hoảng"],
  ["1f92f", "Mind blown", "Choáng váng", "shocked wow amazed", "sốc|bái phục"],
  ["1f633", "Flushed", "Đỏ mặt", "embarrassed oops", "ngượng|xấu hổ"],
  ["1f971", "Yawning", "Ngáp", "tired bored sleepy", "buồn ngủ|chán|mệt"],
  ["1f634", "Sleeping", "Ngủ", "sleep zzz tired", "ngủ|mệt"],
  ["1f644", "Eye roll", "Đảo mắt", "whatever annoyed", "chán|kệ"],
  ["1f624", "Determined", "Quyết tâm", "determined triumph huff", "quyết tâm|hừ"],
  ["1f620", "Angry", "Tức giận", "angry mad", "giận|bực"],
  ["1f92a", "Zany", "Tinh nghịch", "crazy silly fun", "nghịch ngợm|vui nhộn"],
  ["1f60b", "Yummy", "Ngon quá", "yum delicious tasty", "ngon|đói"],
  ["1fae0", "Melting", "Tan chảy", "melting embarrassed hot", "tan chảy|ngượng"],
  ["1f62c", "Grimacing", "Nhăn nhó", "awkward eek", "khó xử|ngại"],
  ["1f630", "Anxious", "Lo lắng", "nervous worried exam", "lo|hồi hộp|thi cử"],
  ["1f635_200d_1f4ab", "Dizzy", "Chóng mặt", "dizzy confused overwhelmed", "chóng mặt|rối|quá tải"],
  // Gestures and encouragement
  ["1f44d", "Thumbs up", "Thích", "like good yes ok", "like|tốt|đồng ý|được"],
  ["1f44e", "Thumbs down", "Không thích", "dislike no bad", "không|chưa được"],
  ["1f44f", "Clapping", "Vỗ tay", "clap bravo applause|well done", "vỗ tay|hoan hô|giỏi lắm"],
  ["1f64c", "Raising hands", "Hoan hô", "hooray celebrate yay", "hoan hô|tuyệt|yeah"],
  ["1faf6", "Heart hands", "Tay trái tim", "love thanks support", "yêu thương|cảm ơn"],
  ["1f44b", "Waving", "Vẫy tay", "hello hi bye", "xin chào|tạm biệt|chào"],
  ["270b", "Raised hand", "Giơ tay", "question me|raise hand", "giơ tay|phát biểu|em ạ"],
  ["1f44c", "OK", "OK", "ok perfect fine", "ổn|được|hoàn hảo"],
  ["270c_fe0f", "Victory", "Chiến thắng", "peace victory yeah", "chiến thắng|hòa bình"],
  ["1f91e", "Fingers crossed", "Cầu may", "luck hope|good luck", "may mắn|hi vọng|chúc may mắn"],
  ["1f4aa", "Flexed biceps", "Cố lên", "strong fighting|you can do it", "cố lên|mạnh mẽ|cố gắng"],
  ["1f64f", "Folded hands", "Cảm ơn", "thanks please pray", "cảm ơn|làm ơn|cầu mong"],
  ["1f91d", "Handshake", "Bắt tay", "deal agree team", "đồng ý|hợp tác|thỏa thuận"],
  ["1f44a", "Fist bump", "Cụng tay", "team bro|fist bump", "cụng tay|đồng đội"],
  ["1f91f", "Love you", "Yêu bạn", "ily|love you", "yêu|thương"],
  ["1faf5", "Pointing at you", "Chỉ bạn", "you|your turn", "bạn đó|tới lượt bạn"],
  ["1f449", "Pointing right", "Chỉ sang phải", "look here next", "nhìn này|tiếp theo"],
  ["270d_fe0f", "Writing", "Đang viết", "write notes homework", "ghi chép|viết bài|bài tập"],
  ["1f440", "Eyes", "Đôi mắt", "look watching see", "xem|nhìn|chú ý"],
  ["1f4af", "Hundred points", "100 điểm", "100 perfect score", "điểm tuyệt đối|xuất sắc|100 điểm"],
  ["1f525", "Fire", "Lửa", "fire hot lit awesome", "cháy|đỉnh|tuyệt"],
  ["2728", "Sparkles", "Lấp lánh", "sparkle magic new", "lấp lánh|mới|đẹp"],
  ["1f31f", "Glowing star", "Ngôi sao sáng", "star excellent best", "ngôi sao|xuất sắc|giỏi"],
  // Hearts
  ["2764_fe0f", "Red heart", "Trái tim đỏ", "love heart", "yêu|tim"],
  ["1f496", "Sparkling heart", "Tim lấp lánh", "love sparkle", "yêu|tim"],
  ["1f495", "Two hearts", "Hai trái tim", "love friends", "yêu|bạn bè"],
  ["1f494", "Broken heart", "Tim vỡ", "sad heartbreak", "buồn|tan vỡ"],
  // Celebration
  ["1f389", "Party popper", "Pháo giấy", "congrats party celebrate", "chúc mừng|ăn mừng"],
  ["1f38a", "Confetti ball", "Bóng giấy màu", "congrats celebrate", "chúc mừng|liên hoan"],
  ["1f388", "Balloon", "Bóng bay", "party birthday", "bóng bay|sinh nhật"],
  ["1f382", "Birthday cake", "Bánh sinh nhật", "birthday cake", "sinh nhật|bánh kem"],
  ["1f381", "Gift", "Quà tặng", "gift present reward", "quà|phần thưởng"],
  ["1f386", "Fireworks", "Pháo hoa", "fireworks celebrate|new year", "pháo hoa|năm mới"],
  ["1f3c6", "Trophy", "Cúp vô địch", "win champion trophy", "vô địch|chiến thắng|giải nhất"],
  ["1f947", "Gold medal", "Huy chương vàng", "first gold winner", "hạng nhất|huy chương"],
  ["1f451", "Crown", "Vương miện", "king queen best", "vua|nhất"],
  ["1f308", "Rainbow", "Cầu vồng", "rainbow hope", "cầu vồng|hi vọng"],
  ["1f680", "Rocket", "Tên lửa", "launch fast go", "xuất phát|tăng tốc|bứt phá"],
  ["1f3af", "Bullseye", "Trúng đích", "goal target correct", "mục tiêu|chính xác|trúng"],
  // Study
  ["1f393", "Graduation cap", "Mũ tốt nghiệp", "graduate school study", "tốt nghiệp|học|ra trường"],
  ["1f4da", "Books", "Chồng sách", "books study read homework", "sách|học bài|đọc"],
  ["270f_fe0f", "Pencil", "Bút chì", "pencil write exercise", "bút chì|viết|làm bài"],
  ["1f4a1", "Light bulb", "Ý tưởng", "idea insight|got it", "ý tưởng|hiểu rồi|sáng kiến"],
  ["1f9e0", "Brain", "Bộ não", "brain smart think", "não|thông minh|suy nghĩ"],
  ["1f4bb", "Laptop", "Máy tính", "laptop computer online", "máy tính|học online"],
  ["1f4c8", "Chart increasing", "Tiến bộ", "progress improve grow", "tiến bộ|tăng|phát triển"],
  ["23f0", "Alarm clock", "Đồng hồ báo thức", "alarm time deadline|wake up", "báo thức|giờ học|hạn chót"],
  ["23f3", "Hourglass", "Đồng hồ cát", "wait time loading", "chờ|thời gian|đợi"],
  ["1f514", "Bell", "Chuông", "bell reminder notice", "chuông|nhắc nhở|thông báo"],
  ["1f4e3", "Megaphone", "Loa thông báo", "announcement attention", "thông báo|chú ý"],
  ["1f50e", "Magnifying glass", "Kính lúp", "search look research", "tìm kiếm|tra cứu"],
  ["2705", "Check mark", "Đúng", "done correct yes", "xong|đúng|hoàn thành"],
  ["274c", "Cross mark", "Sai", "wrong no incorrect", "sai|không"],
  ["2753", "Question mark", "Câu hỏi", "question what why", "câu hỏi|hỏi|tại sao"],
  ["2757", "Exclamation mark", "Chú ý", "important attention warning", "quan trọng|lưu ý"],
  ["1f4ac", "Speech bubble", "Trò chuyện", "chat comment talk", "nhắn tin|bình luận|nói chuyện"],
  ["2615", "Hot drink", "Giải lao", "coffee tea break", "cà phê|trà|nghỉ giải lao"],
];

/**
 * SHA-256 of each upstream `<codepoint>/512.webp`, retrieved 2026-11-28.
 * Regenerate with `--print-lock` only as a reviewed change.
 */
const SOURCE_SHA256 = {
  "2615": "9bce7ae828ab45b6a889f52c7bd072d93f798b1eacab899ecbb275ee184c6629",
  "2705": "21d3e05606b552902dc221e04c8144809ed650ee2c018a01249803d5ccf85bdb",
  "2728": "6f02d6b946908b6bb33452ff81f613928b0a30c09d51d0b43a85d35359e5d1cc",
  "2753": "fc506fedefda8cfd161996d6ec5f3cadaa352333f7424ec46e57d512e109333a",
  "2757": "776e02dd6533b36ef17137c709dc8381bacec6fa55bbbcf182b075565b9439f6",
  "1f600": "99ae57c7ca271adaa211f2c3e599e996dcc2d962564e49bcd979671e5c73146f",
  "1f603": "a3c2eb229ef140b731b1bfabb5aa7c45656cfdff56a4ac0043c469a972ddfc1a",
  "1f604": "43a3dfe932da3b430ee7db85eca6ccc42ac52da4d7009caa7c962d69fde4d88e",
  "1f601": "d3db2f7b94efd6faca3356be1b1979f5ac0659d6d9acdc771ea1c8ed15517f6c",
  "1f606": "67a6a4bc49708c519ab9f0c3ada4fb8d0fed46b40026d7e7aad7157a3a079756",
  "1f605": "2cb382210d45c594c606fcd1bc7faf91f67c6709c7f143c2d7c78c85b5979b60",
  "1f602": "281d5ceb7881fe9393c200ea16c73a4d53af58b4ff04d76a46c432e7e4dd0901",
  "1f923": "6dc164b225a4688da15a6642c366e9eb536a0bfb5fe5a475a75c94d2fe14eba5",
  "1f60a": "cd29299c0bfd6c49484c3e536208a81ba1473b80e7236ba7b6ca07c81a21dd6e",
  "1f607": "438e8256a8fce73e9fa439fcb0b7b55ed7d9cabaa2dab6c617a6a59067ed1c0e",
  "1f642": "649b1026c246417a42e7bb6d0dcb1b3832c7eef8ace5a2e2167270850295b075",
  "1f643": "4df5aa853f57b632d7ce78956c6effa191bc4d9057d5bd93100173452af6a1c5",
  "1f609": "ab2dfbceeae29a7a1b6ff0bb2cfb9d2abb779b0b3dbb428907ecdf7532b383fb",
  "1f60d": "f9a12dd0779299de1c77d8c6168be39ad0f5c579b7ac46f9c77d60be042bc3de",
  "1f970": "7734ab5ea4f0f8169df1f9d0faa00983d1d535b9d73b8d4243250531ea9ed898",
  "1f618": "acb27c59d0dc049d5b56dacee775e0a7b4049f226017e6ecd126cf3480199f3d",
  "1f929": "878a5c5ac1397cf4f79cb73bdb4d077e0eb19b633ebc46dbdf53ecb74223d2b6",
  "1f973": "fcf2af3bb9244afe32685f0293ff2ad3f4fb3575e93fec3054f59c052b82762f",
  "1f60e": "16e9f241e5471c77bd94b3ff1fbdfd4a37e2056d6485256db41729165b57e66f",
  "1f913": "febaf220b3d57f8d0b3d2ad9b2ea65abac93bbbc49b5a3c862c499811d327c48",
  "1f914": "4f8cbd8d563d8bf16d4d7043c3e91afcfe514389bd7e81cc5624f6097aa2053c",
  "1f9d0": "3df2a5daf0aa56d5d7a2440bb99e1b95cd255dacd63a87eb4c4fa34e39901baf",
  "1f92b": "86e9f17633ec9264b99dea4f7b2bc9893b27e8560f07246dd1987960c36d782e",
  "1f917": "a8807ffe440c7f9b13095256079cad2ff12e92caad4a203d49b3199987e54628",
  "1fae1": "2e412f3ed5161935042c979329a55d5c3348dcce497e27b05a590b0c29f8e99d",
  "1f972": "6f53a5f8ad196831fd77c1ff567b63ac6d575d2462247d6fd672fce7d017c06d",
  "1f979": "851edd07bdb19521795f537a4ada613aee05af4c8ac459553422ca66d9861729",
  "1f97a": "db4446e84b80998e3f554c6379efe02cb35f2108d0a1372055f464cdec51ed5b",
  "1f62d": "13a7a4b7e6d920b83f899ca64312bed80280507e93c04bd6e2361764db975a50",
  "1f622": "d2601ea4398ad6154ace98fb3d786049a92cf6bccd0c9c58a835da72ed5b960a",
  "1f614": "a3b0c78891d1a8ae3eead27771e0efaa643826b3d4cd9321baea1023641f76d1",
  "1f62e": "ef22fc1e1f4508a0bb2f5a889fe03d1da5fc528d3d63136e31bf29149c4426b5",
  "1f631": "960377ff1bbe23d763c32facd45654d1d3b38aaa9d4f5cc4b296bf3c79b9b007",
  "1f92f": "9bda8e4f7c8941625b0ae64c2c3c85c794bbbe14f8e7bdd13b92b34c726ac59e",
  "1f633": "2a7cda4b552157ddf99152c64583afb844c3883994fde0d8e0d3ba09c4b0e4ea",
  "1f971": "4e8b5c65cb7b05e3ad8406c3d29171bf13dc2183307cd6fc0ba73266d96c1114",
  "1f634": "ca41f50126de30ef67ae2df42f17ae3fd2ffd7deb7b1bba6d2e4141b1ff2ce3f",
  "1f644": "324bde5da39264d5cbd61308aae42174fb03081349333e0467e144402e94f1a1",
  "1f624": "b44cb26852ae2fb722d2cf9fd756f8967c4abb66e32fe14bcc1940019681c077",
  "1f620": "578ef788244e539b7a3c7caa3cc53c4d8ea5227a5de9a7ea6d89eb6799bb52ee",
  "1f92a": "9c442622ad3613f98bc0f88705856972c31b84869df366d1535f99812c6ff22a",
  "1f60b": "326317843daeaf9929226597fd5b14622ed1077bb9d29741a953c12f9ddc211d",
  "1fae0": "b641677314fcb258d2114fb84d32c6b5a92a2db984d40c5ab439927cb16126b6",
  "1f62c": "f3b9b8733f225f47e6d1da430bc367cc386b1546ac45f6c746a8d6048ab9d163",
  "1f630": "84b91eec04c711b5d743a76e5195b513ec7209c6415a042f7f4b9dce77dde7ac",
  "1f635_200d_1f4ab": "eda6f0a3c978b7f58fd8f4f2f9da5681b52866cb2632cf112bee280e4f3243ea",
  "1f44d": "f456f329ec2457828e0511f31b855e1b3b21c91f53d7d465dc3a1aa7d3b73383",
  "1f44e": "9e03c03aff588ce944addcbc80ed16a80146c70546a795adc40201b4a3b5a184",
  "1f44f": "424f978963357da085a444e1b659028a5f7ccd927d72158ef5c97c82d3ddfd20",
  "1f64c": "51accc877dc32ac4ecfbb5745b89afdf1f610c7e23c4fb292f4bea3dd603fa44",
  "1faf6": "d8f33f7d5188f343efc7a27f43bd5d181376f350239e25c5b349f759f0d5bf0e",
  "1f44b": "2209749c084f37f914e7878346b1285896f4ce9d1a3f5294db93779c00186fa9",
  "270b": "e91f0bd997147d9d8446bf0e21db7dc49aeee9fa87992a485460db1acbd84f34",
  "1f44c": "6a47bdee96c2a11af32d6a4eed5c6528292aa64e6333fb204b7112939ec6c8fd",
  "270c_fe0f": "116172b2c450bd61d99c844eba03d92bc16ca674e98ec6d76f927f409d5cf321",
  "1f91e": "7c592dbd1102d01d98c5d70c429d14da9814815243714bc5e2cae12891929ba0",
  "1f4aa": "fdbf8494ad8c8235bcfec94e751b5570a398bb328020e5282f3923535389548e",
  "1f64f": "648eb5ee603e776d4452ea78f2a89b7b08c3f4110d4afa7ed3954622a1499a68",
  "1f91d": "400eb5356ebec89f85ddf6e955bfa6ad56103cdda2282c9e02f0160285545c0b",
  "1f44a": "bbdb6c67923a138258689da6c09b8d7dcbb2baed55451a7fc61bd2db416062ee",
  "1f91f": "20a0b2b1427912415f4485339a429a3b4080808a17b67f2d6c0637c5b22a8e46",
  "1faf5": "6711474d96214fcf1d511ad5b8c8e65eedb41d56b2c391bf9982341cffae0523",
  "1f449": "d29baece441dbd71bd5863ff40fdf1e9d4361e202f9ccb82d2e5871c1af3c7d2",
  "270d_fe0f": "33e4bbcc3a0aa53a56655af971fe9c6a4916107d512d98c6eb0d1cac62ee3047",
  "1f440": "44da2fbd6e9ec1dee07808fef5216fb8393d78155c7f104be99525215961e07e",
  "1f4af": "c9fdc6075233c9fbd1b77b4df0107187a543223b9ff566fd65a887f221b21008",
  "1f525": "8c18972a71041700a1da4d9a1586640fb6d55eff4dc64efd29efde6a384a2ff5",
  "1f31f": "0fe335effdfa7a35334ebd1f2c4b4ba12bfb7a21dd44a458080bc45b365a073d",
  "2764_fe0f": "8f02722ca349a1b1a0c7a02d7ec3c716e09eccdbf696adf89c67afe2bb175b56",
  "1f496": "56a448bb667eab7573047a671f706782b757282e1b737b22abdb2c01fff3f36f",
  "1f495": "4a6477e379d77a407443ce8a8ae75b3f304d6d7909533ce739c78ab63c4bd065",
  "1f494": "ccbcbf0f3e1fdb8307072f5f13794f7fa44234518c28bf426ef4f393c0a62cea",
  "1f389": "aeff875df341bb7136fa4c84538000a3d4aea8a6dd16245ee8fa1c8bbfeb6ddc",
  "1f38a": "85ca810ff267af819a4025d934af583986ebb6efd1bef4e03be11e49a102cb88",
  "1f388": "d022299b1b1503d9d825e010b20f3727e95c7c90c7bdb0d7095d22a5b9bede13",
  "1f382": "57084b37f4492e470880278badf4e434777982e3eec63fa278e75a16d853575e",
  "1f381": "14c1aa3148391097d2b90f60afb1acec91d971ffa995862dc50a3b91902e3a36",
  "1f386": "431d168d54be2a59210b60d729e375cae4944ad8bc6374ea71ec603b4a56a8ee",
  "1f3c6": "955179c00e7203213f98c3f7ba45c83a4cf9b8a7c2a9a5526c2bda907154ef1e",
  "1f947": "51f7a3e549979f61319667a5672cf0c7e2d332b0786caf2881aaf0152761e477",
  "1f451": "417a684a29863015a30108202d5a3cd7752fd8d54bc86a5fb7a2f752e6932a79",
  "1f308": "d51c54e1cecf2ec9395c2803a25ee83a42fdce73c3520de64207097d8fea05ba",
  "1f680": "304e710dde0b42b15673e10937623789adf72cae569c0e0defe7ec21c0bdf293",
  "1f3af": "5c561a2c23796b9cbc0aa966f8899b4f1019616a456d35224f819caa163ee4d9",
  "1f393": "5ef723a7edeb817d9880108941c79ebde2ee13645a46033eaac277aeaedccbad",
  "1f4da": "af1e5a2aa1222f35fa1ebbe33aa3ddf98361ecb186967ce4ce3c294a3ca9ab0c",
  "270f_fe0f": "3f76ae9f91bc99e72bbb4e8bb97b65346f50ab9f41383274e13580b126a5ccf7",
  "1f4a1": "aae84c10307e31042dd9dc3d6c1b4561dd3965cde26343646d16a155119f408a",
  "1f9e0": "d145a399be0961ee3d3f1657ccb829a3b81ef50fb7eafb0404d5be16eacf141f",
  "1f4bb": "8536d19d5ca7c24711a4d44b543d9b8d7692d7572d337cd2b483c5a51ce0154e",
  "1f4c8": "e9c999b44c5d28ac6436c2b5cf47be59445fb99747154ffe05eaa23cee96ad67",
  "23f0": "884c11089a2658f83f68a452c1830db78399385156d7b736ebb3c33d4c6592d1",
  "23f3": "1de0ff710db532d6077c0d8de49ea53d2aa5734ff6c9a01ed123a67cbb68e36d",
  "1f514": "743b1168d677dd130f85bc748900d2ae57d9fb9b1549285be4800b666f9e4dfd",
  "1f4e3": "e8f6fa2116045c2326fb0342944bb3166d928440d6809b4edbf6b5172ab7bf68",
  "1f50e": "1c82b88586ab10cdecc17f61309a8cbb1361be0938e54f2de8fd8a18c9477e23",
  "274c": "aebcaa7d5166f971503823d54df388f1f869288096aad3884f7c3ece5913f7e2",
  "1f4ac": "58118865ee9119afd2b095f168cefbafc41df6ec54743753c3ddf8bd81f550cc",
};

/* ---------------------------------------------------------------------- */

function fail(message) {
  console.error(`generate-sticker-catalog: ${message}`);
  process.exit(1);
}

function englishKeywords(value) {
  // English: the part before the first "|" is space-separated words, every
  // later "|" part is a phrase ("salute yes respect|got it").
  const [words = "", ...phrases] = value.split("|");
  return [
    ...new Set([
      ...words.split(" ").filter(Boolean),
      ...phrases.map((phrase) => phrase.trim()).filter(Boolean),
    ]),
  ];
}

function vietnameseKeywords(value) {
  // Vietnamese words are multi-syllable, so "|" separates every keyword.
  return [
    ...new Set(
      value
        .split("|")
        .map((word) => word.trim())
        .filter(Boolean),
    ),
  ];
}

export function buildCatalog() {
  const seen = new Set();
  const stickers = STICKERS.map(([codepoint, en, vi, enWords, viWords]) => {
    if (!/^[0-9a-f]{2,6}(?:_[0-9a-f]{2,6}){0,7}$/u.test(codepoint)) {
      fail(`invalid codepoint ${codepoint}`);
    }
    const id = `${PACK_ID}:${codepoint}`;
    if (seen.has(id)) fail(`duplicate sticker ${id}`);
    seen.add(id);
    return {
      id,
      labels: { vi, en },
      keywords: { vi: vietnameseKeywords(viWords), en: englishKeywords(enWords) },
      width: STICKER_SIZE,
      height: STICKER_SIZE,
      animated: true,
      status: "active",
    };
  });
  return {
    catalog_version: CATALOG_VERSION,
    packs: [{ ...PACK, stickers }],
  };
}

/** Pretty JSON in the repository's Prettier style (format:check covers it). */
async function catalogText() {
  const text = `${JSON.stringify(buildCatalog(), null, 2)}\n`;
  try {
    const prettier = await import("prettier");
    const options = (await prettier.resolveConfig(catalogPath)) ?? {};
    return await prettier.format(text, { ...options, filepath: catalogPath });
  } catch {
    return text;
  }
}

function catalogMatches(text) {
  try {
    return JSON.stringify(JSON.parse(text)) === JSON.stringify(buildCatalog());
  } catch {
    return false;
  }
}

function codepoints() {
  return STICKERS.map(([codepoint]) => codepoint);
}

function packDir() {
  return join(stickersRoot, PACK_ID, PACK_VERSION);
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/* ---- WebP header inspection (no decoder needed) ---------------------- */

function readWebPInfo(buffer) {
  if (
    buffer.length < 30 ||
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WEBP"
  ) {
    return null;
  }
  const riffSize = buffer.readUInt32LE(4);
  if (riffSize + 8 !== buffer.length) return null;
  let offset = 12;
  let width = 0;
  let height = 0;
  let animated = false;
  let frames = 0;
  while (offset + 8 <= buffer.length) {
    const type = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (body + size > buffer.length) return null;
    if (type === "VP8X") {
      animated = (buffer[body] & 0x02) !== 0;
      width = buffer.readUIntLE(body + 4, 3) + 1;
      height = buffer.readUIntLE(body + 7, 3) + 1;
    } else if (type === "ANMF") {
      frames += 1;
    } else if (type === "VP8 " && width === 0) {
      width = buffer.readUInt16LE(body + 6) & 0x3fff;
      height = buffer.readUInt16LE(body + 8) & 0x3fff;
    } else if (type === "VP8L" && width === 0) {
      const bits = buffer.readUInt32LE(body + 1);
      width = (bits & 0x3fff) + 1;
      height = ((bits >> 14) & 0x3fff) + 1;
    }
    offset = body + size + (size % 2);
  }
  return { animated, frames, height, width };
}

/* ---- check ----------------------------------------------------------- */

function listFiles(root) {
  if (!existsSync(root)) return [];
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else files.push(path);
    }
  };
  walk(root);
  return files;
}

export function check() {
  const problems = [];
  const count = STICKERS.length;
  if (count < MIN_STICKERS || count > MAX_STICKERS) {
    problems.push(`sticker count ${count} is outside ${MIN_STICKERS}-${MAX_STICKERS}`);
  }
  if (!existsSync(catalogPath)) {
    problems.push(`missing ${relative(repoRoot, catalogPath)}`);
  } else if (!catalogMatches(readFileSync(catalogPath, "utf8"))) {
    problems.push(`${relative(repoRoot, catalogPath)} is stale; run the generator`);
  }
  for (const path of noticesPaths) {
    const text = existsSync(path) ? readFileSync(path, "utf8") : "";
    if (
      !text.includes("Noto Emoji Animation") ||
      !text.includes("CC BY 4.0") ||
      !text.includes("https://creativecommons.org/licenses/by/4.0/")
    ) {
      problems.push(`${relative(repoRoot, path)} must credit Noto Emoji Animation under CC BY 4.0`);
    }
  }
  const expected = new Map();
  for (const codepoint of codepoints()) {
    expected.set(join(packDir(), `${codepoint}.webp`), "animated");
    expected.set(join(packDir(), `${codepoint}.static.webp`), "static");
  }
  const files = listFiles(stickersRoot);
  let total = 0;
  for (const path of files) {
    const size = statSync(path).size;
    total += size;
    const kind = expected.get(path);
    const name = relative(webRoot, path).split(sep).join("/");
    if (!kind) {
      problems.push(`unexpected file ${name}`);
      continue;
    }
    const info = readWebPInfo(readFileSync(path));
    if (!info) {
      problems.push(`${name} is not a well-formed WebP file`);
      continue;
    }
    if (info.width !== STICKER_SIZE || info.height !== STICKER_SIZE) {
      problems.push(`${name} is ${info.width}x${info.height}, want ${STICKER_SIZE}x${STICKER_SIZE}`);
    }
    if (kind === "animated") {
      if (!info.animated || info.frames < 2) problems.push(`${name} is not animated`);
      if (size > ANIMATED_LIMIT) problems.push(`${name} is ${size} bytes (> ${ANIMATED_LIMIT})`);
    } else {
      if (info.animated) problems.push(`${name} must be a single static frame`);
      if (size > STATIC_LIMIT) problems.push(`${name} is ${size} bytes (> ${STATIC_LIMIT})`);
    }
  }
  for (const path of expected.keys()) {
    if (!files.includes(path)) {
      problems.push(`missing ${relative(webRoot, path).split(sep).join("/")}`);
    }
  }
  if (files.length > FILE_LIMIT) {
    problems.push(`${files.length} files exceed the ${FILE_LIMIT}-file budget`);
  }
  if (total > TOTAL_LIMIT) {
    problems.push(`${total} bytes exceed the ${TOTAL_LIMIT}-byte budget`);
  }
  if (problems.length > 0) {
    for (const problem of problems) console.error(`  - ${problem}`);
    fail(`${problems.length} problem(s) in the sticker pack`);
  }
  console.log(
    `sticker pack ok: ${count} stickers, ${files.length} files, ` +
      `${total} bytes (${(total / 1024 / 1024).toFixed(2)} MB of ${TOTAL_LIMIT / 1024 / 1024} MB)`,
  );
}

/* ---- sources --------------------------------------------------------- */

function sourcePath(sourceDir, codepoint) {
  return join(sourceDir, `${codepoint}.${SOURCE_SIZE}.webp`);
}

async function ensureSources(sourceDir, { offline, verify }) {
  mkdirSync(sourceDir, { recursive: true });
  const digests = {};
  for (const codepoint of codepoints()) {
    const path = sourcePath(sourceDir, codepoint);
    if (!existsSync(path)) {
      if (offline) fail(`missing source ${path} (offline)`);
      const url = `${SOURCE_BASE}/${codepoint}/${SOURCE_SIZE}.webp`;
      const response = await fetch(url, { redirect: "error" });
      if (!response.ok) fail(`download ${url} failed with HTTP ${response.status}`);
      const body = Buffer.from(await response.arrayBuffer());
      const partial = `${path}.partial`;
      writeFileSync(partial, body);
      renameSync(partial, path);
    }
    const digest = sha256(readFileSync(path));
    digests[codepoint] = digest;
    if (verify && SOURCE_SHA256[codepoint] !== digest) {
      fail(
        `SHA-256 mismatch for ${codepoint}: got ${digest}, pinned ${SOURCE_SHA256[codepoint] ?? "(none)"}; ` +
          "review the upstream change and run --print-lock",
      );
    }
  }
  return digests;
}

/* ---- transcoding (build time only) ----------------------------------- */

const TRANSCODER = String.raw`
import io, json, os, sys
from PIL import Image, ImageChops, ImageSequence, ImageStat

job = json.load(sys.stdin)
size = job["size"]
results = []
for item in job["items"]:
    with Image.open(item["source"]) as image:
        if not getattr(image, "is_animated", False):
            raise SystemExit(item["codepoint"] + ": source is not animated")
        frames, durations = [], []
        for frame in ImageSequence.Iterator(image):
            frames.append(frame.convert("RGBA").resize((size, size), Image.Resampling.LANCZOS))
            durations.append(int(frame.info.get("duration") or 40))
    chosen = None
    for step, quality in job["ladder"]:
        kept = frames[::step]
        merged = [sum(durations[i:i + step]) for i in range(0, len(durations), step)]
        if len(kept) < 2:
            continue
        buffer = io.BytesIO()
        kept[0].save(buffer, "WEBP", save_all=True, append_images=kept[1:], duration=merged,
                     loop=0, quality=quality, method=4)
        data = buffer.getvalue()
        chosen = (data, step, quality, len(kept))
        if len(data) <= job["animated_target"]:
            break
    if chosen is None or len(chosen[0]) > job["animated_limit"]:
        raise SystemExit(item["codepoint"] + ": animated sticker exceeds the size limit")
    # Many animations open on a neutral pose; the frame that differs most
    # from the first shows the expression the sticker is named for.
    representative = max(
        range(len(frames)),
        key=lambda index: (sum(ImageStat.Stat(ImageChops.difference(frames[0], frames[index])).sum), -index),
    )
    still = None
    for quality in (82, 72, 62, 50, 40):
        buffer = io.BytesIO()
        frames[representative].save(buffer, "WEBP", quality=quality, method=4)
        still = buffer.getvalue()
        if len(still) <= job["static_limit"]:
            break
    if len(still) > job["static_limit"]:
        raise SystemExit(item["codepoint"] + ": static sticker exceeds the size limit")
    with open(item["animated"], "wb") as handle:
        handle.write(chosen[0])
    with open(item["static"], "wb") as handle:
        handle.write(still)
    results.append({"codepoint": item["codepoint"], "frames": chosen[3], "source_frames": len(frames),
                    "step": chosen[1], "quality": chosen[2], "animated_bytes": len(chosen[0]),
                    "static_bytes": len(still), "static_frame": representative})
    print(json.dumps(results[-1]), file=sys.stderr, flush=True)
json.dump(results, sys.stdout)
`;

function transcode(sourceDir, python) {
  const staging = join(stickersRoot, `.staging-${process.pid}`);
  rmSync(staging, { force: true, recursive: true });
  mkdirSync(staging, { recursive: true });
  const items = codepoints().map((codepoint) => ({
    animated: join(staging, `${codepoint}.webp`),
    codepoint,
    source: sourcePath(sourceDir, codepoint),
    static: join(staging, `${codepoint}.static.webp`),
  }));
  const result = spawnSync(python, ["-I", "-c", TRANSCODER], {
    cwd: tmpdir(),
    encoding: "utf8",
    input: JSON.stringify({
      animated_limit: ANIMATED_LIMIT,
      animated_target: ANIMATED_TARGET,
      items,
      ladder: ENCODE_LADDER,
      size: STICKER_SIZE,
      static_limit: STATIC_LIMIT,
    }),
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["pipe", "pipe", "inherit"],
  });
  if (result.error) {
    rmSync(staging, { force: true, recursive: true });
    fail(`cannot run ${python} (Python 3 with Pillow is required): ${result.error.message}`);
  }
  if (result.status !== 0) {
    rmSync(staging, { force: true, recursive: true });
    fail(`transcoder exited with status ${result.status}`);
  }
  rmSync(packDir(), { force: true, recursive: true });
  mkdirSync(dirname(packDir()), { recursive: true });
  renameSync(staging, packDir());
  // Drop any other pack version or stray file under public/stickers.
  for (const entry of readdirSync(stickersRoot)) {
    if (entry !== PACK_ID) rmSync(join(stickersRoot, entry), { force: true, recursive: true });
  }
  for (const entry of readdirSync(join(stickersRoot, PACK_ID))) {
    if (entry !== PACK_VERSION) {
      rmSync(join(stickersRoot, PACK_ID, entry), { force: true, recursive: true });
    }
  }
  return JSON.parse(result.stdout);
}

/* ---- CLI ------------------------------------------------------------- */

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  if (process.argv.includes("--check")) {
    check();
    return;
  }
  const sourceDir = resolve(
    argument("--source-dir") ?? join(tmpdir(), "tutorhub-noto-emoji-animation"),
  );
  const offline = process.argv.includes("--offline");
  if (process.argv.includes("--print-lock")) {
    const digests = await ensureSources(sourceDir, { offline, verify: false });
    console.log(JSON.stringify(digests, null, 2));
    return;
  }
  await ensureSources(sourceDir, { offline, verify: true });
  const python = argument("--python") ?? process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");
  const report = transcode(sourceDir, python);
  mkdirSync(dirname(catalogPath), { recursive: true });
  writeFileSync(catalogPath, await catalogText());
  const animated = report.reduce((sum, item) => sum + item.animated_bytes, 0);
  const still = report.reduce((sum, item) => sum + item.static_bytes, 0);
  console.log(
    `transcoded ${report.length} stickers: animated ${animated} bytes, static ${still} bytes`,
  );
  check();
}

await main();
