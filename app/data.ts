import { generatedChampions, sourceSync } from "./generated-guides";

export type Role = "Tất cả" | "Đấu sĩ" | "Xạ thủ" | "Pháp sư" | "Đỡ đòn" | "Sát thủ" | "Hỗ trợ";
export type Tier = "SSS" | "SS" | "S" | "A" | "B";

export type Augment = {
  vi: string;
  cn: string;
  note?: string;
  id?: number;
  icon?: string;
};

export type ItemAsset = {
  name: string;
  original: string;
  id?: number;
  icon?: string;
};

export type ChampionGuide = {
  id: string;
  ddragon: string;
  championId?: number;
  icon?: string;
  splash?: string;
  name: string;
  title: string;
  aliases: string[];
  role: Exclude<Role, "Tất cả">;
  tier: Tier;
  buildGrade: Tier;
  buildName: string;
  buildOriginal: string;
  summary: string;
  summaryOriginal?: string;
  coreAugments: Augment[];
  items: string[];
  itemData?: ItemAsset[];
  prismatic: Augment[];
  gold: Augment[];
  silver: Augment[];
  tips: string[];
  traps: string[];
  alternatives: string[];
  alternativeOriginals?: string[];
  sourceNotes?: string[];
  sourceModified?: string;
  source: string;
};

const a = (vi: string, cn: string, note?: string): Augment => ({ vi, cn, note });

export const roles: Role[] = ["Tất cả", "Đấu sĩ", "Xạ thủ", "Pháp sư", "Sát thủ", "Đỡ đòn", "Hỗ trợ"];

const curatedChampions: ChampionGuide[] = [
  {
    id: "vayne",
    ddragon: "Vayne",
    name: "Vayne",
    title: "Thợ Săn Bóng Đêm",
    aliases: ["VN"],
    role: "Xạ thủ",
    tier: "SS",
    buildGrade: "S",
    buildName: "Sữa lắc Protein + Kiếm Hoa Bình Minh",
    buildOriginal: "蛋白粉花剑流",
    summary:
      "Lấy chống chịu làm nền, dùng tốc đánh rất cao để kích hoạt vòng Bạc. Lối chơi đứng bắn, vừa gây sát thương chuẩn vừa hỗ trợ hồi phục cho đồng đội.",
    coreAugments: [a("Sữa lắc Protein", "蛋白粉奶昔", "Cho phép ưu tiên trang bị chống chịu mà vẫn giữ lượng sát thương cần thiết.")],
    items: ["Cuồng Đao Guinsoo", "Kiếm Hoa Bình Minh", "Khắc Tinh Ma Quỷ", "Jak'Sho", "Khiên Băng Randuin", "Giáp Thiên Nhiên", "Gươm Vô Danh"],
    prismatic: [a("Song Đao", "双刀流"), a("Búa Liên Kích", "连拨击锤"), a("Ống Ngắm Tối Thượng", "最万用的瞄准镜"), a("Vũ Điệu Thiết Hài", "踢踏舞"), a("Diệt Khổng Lồ", "巨人杀手")],
    gold: [a("Ống Ngắm Nâng Cấp", "更万用的瞄准镜"), a("BANG!", "邦！"), a("Trợ Giúp Nhỏ", "小小的额外帮助"), a("Nâng Cấp: Vô Cực", "升级：无尽之刃"), a("Biến Đổi: Lăng Kính", "质变：棱彩阶")],
    silver: [a("Khéo Léo", "灵巧"), a("Lướt Bóng Tối", "暗影疾奔"), a("Bão Tố", "台风"), a("Ống Ngắm Vạn Năng", "万用瞄准镜"), a("Thắp Sáng Chúng!", "点亮他们！")],
    tips: ["Búa Liên Kích có thể kích hoạt nội tại ba đòn với tần suất rất cao.", "Lướt Bóng Tối cho lượng tốc độ di chuyển lớn sau Q, giúp thả diều dễ hơn."],
    traps: ["Bão Tố có thể làm dấu nội tại Vòng Bạc chuyển sang mục tiêu bị luồng đạn phụ đánh trúng.", "Găng Bảo Thạch không làm sát thương vòng Bạc từ W chí mạng."],
    alternatives: ["Hiệu ứng đòn đánh ba vòng", "Chí mạng", "Nhất kích"],
    source: "https://lolhaidou.cn/hero/vayne.html",
  },
  {
    id: "sett",
    ddragon: "Sett",
    name: "Sett",
    title: "Đại Ca",
    aliases: ["Đại ca"],
    role: "Đấu sĩ",
    tier: "SS",
    buildGrade: "S",
    buildName: "Tiên Răng — R liên tục",
    buildOriginal: "牙仙子无限大招腕豪",
    summary:
      "Dùng xuyên giáp từ lõi chủ chốt và hoàn lại hồi chiêu từ Kiếm Ma Youmuu/Axiom để liên tục bắt mục tiêu bằng R sau mỗi điểm hạ gục.",
    coreAugments: [a("Tiên Răng", "牙仙子", "Xuyên giáp cao, kết hợp trang bị hoàn chiêu cuối để tạo chuỗi R.")],
    items: ["Ngạo Nghễ", "Vòng Cung Axiom", "Giày Tham Thực", "Kiếm Điện Xoáy", "Nỏ Thần Dominik", "Khiên Cương Lực Hextech"],
    prismatic: [a("Goliath", "歌利亚巨人"), a("Phi Thân Cước", "飞身踢"), a("Cuồng Xúc Xắc", "掷骰狂人"), a("Nhiệm Vụ: Icathia Sụp Đổ", "任务：艾卡西亚的陷落"), a("Nhà Khoa Học Điên", "科学狂人")],
    gold: [a("Động Cơ Xe Tăng", "坦克引擎"), a("Nhiệm Vụ: Tôi Luyện Trái Tim", "任务：钢化你心"), a("Cơ Thể Tinh Giới", "星界躯体"), a("Nồi Áp Suất", "高压锅"), a("Trợ Giúp Nhỏ", "小小的额外帮助")],
    silver: [a("Tay Đấm Hạng Nặng", "重量级打击手"), a("Sức Mạnh", "大力"), a("Khủng Long Xếp Tầng", "叠角龙"), a("Tát Liên Hoàn", "扇巴掌"), a("Bậc Thầy Rèn Đúc", "大师铸就")],
    tips: ["W của Sett nhận lợi ích kép từ máu và sức mạnh công kích, vì vậy Goliath đặc biệt mạnh.", "E sẽ làm choáng khi kéo trúng đơn vị ở cả hai phía; có thể dùng lính làm phía còn lại."],
    traps: ["Điện Toán Lượng Tử hiện không còn gây gấp bốn sát thương ở vòng trong, ưu tiên thấp."],
    alternatives: ["Một cú đấm", "Xuyên giáp", "AP bùng nổ"],
    source: "https://lolhaidou.cn/hero/sett.html",
  },
  {
    id: "brand",
    ddragon: "Brand",
    name: "Brand",
    title: "Thần Lửa",
    aliases: ["Hỏa nam"],
    role: "Pháp sư",
    tier: "SS",
    buildGrade: "A",
    buildName: "Ăn Lính Dọc Đường",
    buildOriginal: "吃过路兵火男",
    summary:
      "Nội tại thiêu đốt có thể kích hoạt điểm yếu không phụ thuộc hướng. W, E và R đều là kỹ năng diện rộng nên có thể chạm nhiều điểm yếu trong giao tranh.",
    coreAugments: [a("Ăn Lính Dọc Đường", "吃过路兵", "Tận dụng sát thương lan và thiêu đốt liên tục của Brand.")],
    items: ["Mặt Nạ Đọa Đày Liandry", "Lời Nguyền Đổ Máu", "Quyền Trượng Ác Thần", "Ngọn Lửa Hắc Hóa", "Giáp Tâm Linh", "Jak'Sho"],
    prismatic: [a("Ống Dẫn Hỏa Ngục", "炼狱导管"), a("Eureka", "尤里卡"), a("Đại Pháp Sư", "大法师"), a("Vòng Lặp Vô Hạn", "无限循环往复"), a("Cuồng Xúc Xắc", "掷骰狂人")],
    gold: [a("Lãi Suất Thiêu Đốt", "炽燃利息"), a("Tên Lửa Ma Pháp", "魔法飞弹"), a("Ác Ma Siêu Phàm", "超凡邪恶"), a("Hộp Nước Pháp Sư", "术士果汁盒"), a("Theo Đuổi Hồi Chiêu", "急速之追求")],
    silver: [a("Giá Lạnh", "冰寒"), a("Tư Duy Pháp Sư", "巫师式思考"), a("Song Hỏa", "双生火焰"), a("Bậc Thầy Rèn Đúc", "大师铸就"), a("Xói Mòn", "侵蚀")],
    tips: ["Ống Dẫn Hỏa Ngục có thể biến Brand thành pháp sư xả kỹ năng gần như liên tục.", "Vũ Khí Hư Ảo kết hợp Dễ Tổn Thương và Gươm Vô Danh tạo lượng sát thương rất lớn."],
    traps: ["Đừng dồn toàn bộ trang bị vào một lần nổ nếu đội thiếu sát thương kéo dài."],
    alternatives: ["Ống Dẫn Hỏa Ngục", "Lãi Suất Thiêu Đốt", "Pháp bạo + Dễ Tổn Thương"],
    source: "https://lolhaidou.cn/hero/brand.html",
  },
  {
    id: "yasuo",
    ddragon: "Yasuo",
    name: "Yasuo",
    title: "Kẻ Bất Dung Thứ",
    aliases: ["Đấng", "Hasagi"],
    role: "Đấu sĩ",
    tier: "SS",
    buildGrade: "S",
    buildName: "Lướt Hư Không",
    buildOriginal: "虚空冲刺亚索",
    summary:
      "Tăng nhịp lướt, tạo lá chắn liên tục và đánh xoay quanh ngưỡng hồi Q từ tốc đánh. Nghi Thức Hủy Hoại giúp chuỗi E liên tục tạo khiên.",
    coreAugments: [a("Lướt Hư Không", "虚空冲刺", "Khuếch đại khả năng bám mục tiêu và nhịp giao tranh của Yasuo.")],
    items: ["Cung Hoang Dã Yun Tal", "Nghi Thức Hủy Hoại", "Vũ Điệu Tử Thần", "Giáp Tâm Linh", "Cuồng Nộ Berserker", "Jak'Sho"],
    prismatic: [a("Cú Đấm Bí Thuật", "秘术冲拳"), a("Cuồng Xúc Xắc", "掷骰狂人"), a("Hình Thái Tối Hậu", "最终形态"), a("Ăn Lính Dọc Đường", "吃过路兵"), a("Vũ Điệu Thiết Hài", "踢踏舞")],
    gold: [a("Nâng Cấp: Vô Cực", "升级：无尽之刃"), a("Hào Khí Cuồng Đồ", "狂徒豪气"), a("Lướt Hư Không", "虚空冲刺"), a("Trói Buộc Tham Lam", "贪欲束缚"), a("Biến Đổi: Lăng Kính", "质变：棱彩阶")],
    silver: [a("Khát Máu", "渴血"), a("Sức Mạnh", "大力"), a("Nhanh Mà Chắc", "快中求稳"), a("Phép Thành Vật Lý", "魔法转物理"), a("Lướt Bóng Tối", "暗影疾奔")],
    tips: ["Cú Đấm Bí Thuật giảm 1,25 giây hồi chiêu qua đòn đánh; Q của Yasuo được tính như đòn đánh.", "Tường Gió vẫn chặn đòn đánh thường của xạ thủ có lõi tăng tầm."],
    traps: ["Theo Đuổi Hồi Chiêu không giúp Q vì hồi chiêu Q phụ thuộc tốc đánh, không phụ thuộc điểm hồi kỹ năng.", "Phòng Thủ Chí Mạng thường chỉ có 50% cơ hội giảm sát thương nên không mạnh như vẻ ngoài."],
    alternatives: ["Cú Đấm Bí Thuật — Q liên tục", "Nghi Thức Hủy Hoại — khiên liên tục"],
    source: "https://lolhaidou.cn/hero/yasuo.html",
  },
  {
    id: "ryze",
    ddragon: "Ryze",
    name: "Ryze",
    title: "Pháp Sư Cổ Ngữ",
    aliases: ["Pháp sư lang thang"],
    role: "Pháp sư",
    tier: "SSS",
    buildGrade: "SSS",
    buildName: "Vòng lặp chỉ số 2,1 tỷ SMPT",
    buildOriginal: "21亿法强属性循环流",
    summary:
      "Dùng quan hệ chuyển đổi giữa SMPT và năng lượng tối đa của nội tại Ryze, sau đó ghép các lõi chuyển đổi máu, SMCK và SMPT để tạo vòng lặp chỉ số.",
    coreAugments: [a("Vật Lý Thành Phép", "物理转魔法"), a("Từ Tâm Ra Vật", "由心及物", "Hai lõi bắt buộc của lối chơi vòng lặp chỉ số.")],
    items: ["Quyền Trượng Đại Thiên Sứ", "Manamune", "Băng Giáp Vĩnh Cửu", "Huyết Giáp Chúa Tể", "Quyền Trượng Ác Thần", "Mũ Phù Thủy Rabadon", "Trượng Trường Sinh"],
    prismatic: [a("Trở Về Cơ Bản", "回归基本功"), a("Đại Pháp Sư", "大法师"), a("Quá Tải", "超负荷"), a("Eureka", "尤里卡"), a("Ba Phát", "三重射击")],
    gold: [a("Tràn Năng Lượng", "溢流"), a("Hộp Nước Pháp Sư", "术士果汁盒"), a("Ác Ma Siêu Phàm", "超凡邪恶"), a("Tên Lửa Ma Pháp", "魔法飞弹"), a("Theo Đuổi Hồi Chiêu", "急速之追求")],
    silver: [a("Từ Tâm Ra Vật", "由心及物"), a("Vật Lý Thành Phép", "物理转魔法"), a("Tư Duy Pháp Sư", "巫师式思考"), a("Khát Máu", "渴血"), a("Linh Hồn Đại Dương", "海洋龙魂")],
    tips: ["Tràn Năng Lượng là lợi ích thuần dương vì Ryze luôn cần thêm năng lượng.", "Có Làm Mới Chiêu Cuối, nhấn R hai lần liên tiếp để dịch chuyển ngay."],
    traps: ["Không bán giày trước khi có đủ tốc độ di chuyển.", "Nhiều trang bị Nước Mắt tích số chậm; cần ưu tiên nhịp phát triển."],
    alternatives: ["Ryze súng máy phép thuật"],
    source: "https://lolhaidou.cn/hero/ryze.html",
  },
  {
    id: "master-yi",
    ddragon: "MasterYi",
    name: "Master Yi",
    title: "Kiếm Sư Wuju",
    aliases: ["Yi", "Kiếm sư"],
    role: "Đấu sĩ",
    tier: "SS",
    buildGrade: "B",
    buildName: "Thiền bất tử — bản giải trí",
    buildOriginal: "念经不死流",
    summary:
      "Nâng tối đa W, tích chống chịu và hồi phục để kéo dài giao tranh. Đây là lối giải trí; nếu cần thắng ổn định, ưu tiên nhánh Q vô hạn hoặc hiệu ứng đòn đánh.",
    coreAugments: [a("Sữa lắc Protein", "蛋白粉奶昔"), a("Vòng Tròn Tử Thần", "死亡之环")],
    items: ["Trượng Trường Sinh", "Giáp Tâm Linh", "Tuyệt Vọng Vĩnh Cửu", "Tim Băng", "Jak'Sho", "Giáp Thiên Nhiên"],
    prismatic: [a("Cú Đấm Bí Thuật", "秘术冲拳"), a("Cuồng Xúc Xắc", "掷骰狂人"), a("Hình Thái Tối Hậu", "最终形态"), a("Song Đao", "双刀流"), a("Giao Hưởng Chiến Tranh", "战争交响乐")],
    gold: [a("Trợ Giúp Nhỏ", "小小的额外帮助"), a("Khoái Cảm Tội Lỗi", "罪恶快感"), a("Nâng Cấp: Vô Cực", "升级：无尽之刃"), a("Theo Đuổi Hồi Chiêu", "急速之追求"), a("Dạ Săn", "夜狩")],
    silver: [a("Khát Máu", "渴血"), a("Sức Mạnh", "大力"), a("Bão Tố", "台风"), a("Kế Hoạch Đào Thoát", "逃跑计划"), a("Khéo Léo", "灵巧")],
    tips: ["Cú Đấm Bí Thuật: một Q có thể kích hoạt sáu hiệu ứng đòn đánh; dưới 7,5 giây hồi Q có thể tạo chuỗi Q liên tục.", "Thuần Thục Thân Pháp cấp lượng lớn hồi kỹ năng trực tiếp cho Q."],
    traps: ["Hỏa Lực Cò Súng rất khó tích đủ bảy tầng vì Yi có ít kỹ năng gây sát thương.", "Dùng Q đúng lúc vòng Can Thiệp Thần Thánh hạ xuống có thể khiến Yi không nhận được bất tử."],
    alternatives: ["Chí mạng", "Q vô hạn", "Hiệu ứng đòn đánh"],
    source: "https://lolhaidou.cn/hero/masteryi.html",
  },
  {
    id: "miss-fortune",
    ddragon: "MissFortune",
    name: "Miss Fortune",
    title: "Thợ Săn Tiền Thưởng",
    aliases: ["MF", "Nữ cướp biển"],
    role: "Xạ thủ",
    tier: "SS",
    buildGrade: "S",
    buildName: "Pháp sư Thuần Khiết AP",
    buildOriginal: "纯粹主义术士AP女枪",
    summary:
      "Lõi chuyển tốc đánh thành hồi kỹ năng, trong khi W của Miss Fortune cho lượng tốc đánh lớn. Kết quả là E và R có nhịp dùng dày đặc.",
    coreAugments: [a("Thuần Khiết — Pháp Sư", "纯粹主义者 - 术师", "Chuyển tốc đánh từ W thành điểm hồi kỹ năng.")],
    items: ["Đuốc Lửa Đen", "Song Kiếm Tai Ương", "Mặt Nạ Liandry", "Ngọn Lửa Hắc Hóa", "Quyền Trượng Đại Thiên Sứ", "Lời Nguyền Đổ Máu"],
    prismatic: [a("Diệt Khổng Lồ", "巨人杀手"), a("Eureka", "尤里卡"), a("Ba Phát", "三重射击"), a("Cuồng Xúc Xắc", "掷骰狂人"), a("Đại Pháp Sư", "大法师")],
    gold: [a("Xạ Thủ Lão Luyện", "老练狙神"), a("Nâng Cấp: Vô Cực", "升级：无尽之刃"), a("Trợ Giúp Nhỏ", "小小的额外帮助"), a("Tên Lửa Ma Pháp", "魔法飞弹"), a("Theo Đuổi Hồi Chiêu", "急速之追求")],
    silver: [a("Song Hỏa", "双生火焰"), a("Nâng Cấp: Máy Hái", "升级：收集者"), a("Tư Duy Pháp Sư", "巫师式思考"), a("Sức Mạnh", "大力"), a("Khéo Léo", "灵巧")],
    tips: ["E đã có làm chậm nên AP MF không cần Trượng Pha Lê Rylai.", "Xạ Thủ Lão Luyện hiện có thể được E kích hoạt bình thường."],
    traps: ["Hiệu ứng làm chậm chỉ lấy giá trị cao nhất, không cộng dồn; Rylai vì thế kém hiệu quả."],
    alternatives: ["Xuyên giáp", "Mưa đạn Đại Pháp Sư", "AP cấu rỉa"],
    source: "https://lolhaidou.cn/hero/missfortune.html",
  },
  {
    id: "jax",
    ddragon: "Jax",
    name: "Jax",
    title: "Bậc Thầy Vũ Khí",
    aliases: ["Bậc thầy vũ khí"],
    role: "Đấu sĩ",
    tier: "SS",
    buildGrade: "S",
    buildName: "Song tu Công — Phép",
    buildOriginal: "物法皆修武器",
    summary:
      "Kết hợp hệ số SMCK và SMPT của bộ kỹ năng, giữ nhịp đánh thường ổn định và chuyển giữa chống chịu với dồn sát thương tùy đội hình địch.",
    coreAugments: [a("Song Tu Công — Phép", "物法皆修")],
    items: ["Hoàng Hôn & Bình Minh", "Dao Điện Statikk", "Cuồng Đao Guinsoo", "Kiếm Súng Hextech", "Giáp Tâm Linh", "Vũ Điệu Tử Thần", "Jak'Sho"],
    prismatic: [a("Cú Đấm Bí Thuật", "秘术冲拳"), a("Hình Thái Tối Hậu", "最终形态"), a("Cuồng Xúc Xắc", "掷骰狂人"), a("Đánh Thức Tối Hậu", "终极唤醒"), a("Đại Pháp Sư", "大法师")],
    gold: [a("BANG!", "邦！"), a("Nâng Cấp: Thủy Kiếm", "升级：耀光"), a("Trợ Giúp Nhỏ", "小小的额外帮助"), a("Biến Đổi: Lăng Kính", "质变：棱彩阶"), a("Lướt Hư Không", "虚空冲刺")],
    silver: [a("Khát Máu", "渴血"), a("Sức Mạnh", "大力"), a("Nhanh Mà Chắc", "快中求稳"), a("Kế Hoạch Đào Thoát", "逃跑计划"), a("Bậc Thầy Rèn Đúc", "大师铸就")],
    tips: ["Cú Đấm Bí Thuật + Hoàng Hôn & Bình Minh cho phép dùng E dày, gần như liên tục né đòn đánh.", "Đan xen đòn đánh giữa Q–W–E giúp kích hoạt xếp hạng S của lõi chuỗi kỹ năng."],
    traps: ["Thuần Khiết — Pháp Sư chuyển mất tốc đánh, khiến combo Jax khựng và sát thương thực tế giảm mạnh.", "Xoay Để Thắng chỉ có E nhận được hiệu ứng."],
    alternatives: ["Khủng long xếp tầng", "AP bom hạt nhân", "Cú Đấm Bí Thuật"],
    source: "https://lolhaidou.cn/hero/jax.html",
  },
  {
    id: "varus",
    ddragon: "Varus",
    name: "Varus",
    title: "Mũi Tên Báo Thù",
    aliases: ["Mũi tên báo thù"],
    role: "Xạ thủ",
    tier: "SSS",
    buildGrade: "S",
    buildName: "Song tu Công — Phép",
    buildOriginal: "物法皆修流",
    summary:
      "Đòn đánh tăng SMPT để khuếch đại sát thương kích nổ W. Chuỗi trang bị lai giúp vừa đặt cộng dồn nhanh vừa có một mũi tên kết liễu mạnh.",
    coreAugments: [a("Song Tu Công — Phép", "物法皆修")],
    items: ["Cuồng Cung Runaan", "Dao Điện Statikk", "Cung Giao Giới", "Mũ Phù Thủy Rabadon", "Ngọn Lửa Hắc Hóa", "Khắc Tinh Ma Quỷ", "Khiên Băng Randuin"],
    prismatic: [a("Rút Kiếm!", "亮出你的剑"), a("Diệt Khổng Lồ", "巨人杀手"), a("Song Đao", "双刀流"), a("Cuồng Xúc Xắc", "掷骰狂人"), a("Ống Ngắm Tối Thượng", "最万用的瞄准镜")],
    gold: [a("Theo Đuổi Hồi Chiêu", "急速之追求"), a("Ống Ngắm Nâng Cấp", "更万用的瞄准镜"), a("Xạ Thủ Lão Luyện", "老练狙神"), a("Theo Đuổi Sức Mạnh", "威能之追求"), a("Tên Lửa Ma Pháp", "魔法飞弹")],
    silver: [a("Khéo Léo", "灵巧"), a("Song Hỏa", "双生火焰"), a("Nâng Cấp: Máy Hái", "升级：收集者"), a("Bão Tố", "台风"), a("Sức Mạnh", "大力")],
    tips: ["Vũ Khí Hư Ảo + Hoàng Hôn & Bình Minh có thể đặt hai cộng dồn nội tại chỉ bằng một kỹ năng.", "Cuồng Nhiệt giúp Varus AP đặt đủ ba cộng dồn nhanh hơn."],
    traps: ["E đã có hiệu ứng Vết Thương Sâu, không cần mua thêm trang bị giảm hồi máu chỉ vì mục đích đó."],
    alternatives: ["AP một mũi tên", "Hiệu ứng đòn đánh"],
    source: "https://lolhaidou.cn/hero/varus.html",
  },
  {
    id: "ashe",
    ddragon: "Ashe",
    name: "Ashe",
    title: "Cung Băng",
    aliases: ["Cung băng"],
    role: "Xạ thủ",
    tier: "SS",
    buildGrade: "S",
    buildName: "Cú Đấm Bí Thuật — R liên tục",
    buildOriginal: "秘术冲拳无限大招流",
    summary:
      "Khi bật Q, mỗi đòn đánh thêm một lần hiệu ứng nên kích hoạt Cú Đấm Bí Thuật hai lần. Cuối trận chỉ cần vài đòn đánh để làm mới Đại Băng Tiễn.",
    coreAugments: [a("Cú Đấm Bí Thuật", "秘术冲拳")],
    items: ["Dao Điện Statikk", "Lệnh Đế Vương", "Dịch Bệnh", "Cuồng Cung Runaan", "Lột Xác", "Kính Nhắm Ma Pháp"],
    prismatic: [a("Song Đao", "双刀流"), a("Ống Ngắm Tối Thượng", "最万用的瞄准镜"), a("Vũ Điệu Thiết Hài", "踢踏舞"), a("Diệt Khổng Lồ", "巨人杀手"), a("Gối Châm", "针插垫")],
    gold: [a("Trợ Giúp Nhỏ", "小小的额外帮助"), a("Ống Ngắm Nâng Cấp", "更万用的瞄准镜"), a("Nâng Cấp: Vô Cực", "升级：无尽之刃"), a("Biến Đổi: Lăng Kính", "质变：棱彩阶"), a("Theo Đuổi Hồi Chiêu", "急速之追求")],
    silver: [a("Khéo Léo", "灵巧"), a("Bão Tố", "台风"), a("Ống Ngắm Vạn Năng", "万用瞄准镜"), a("Thắp Sáng Chúng!", "点亮他们！"), a("Tiến Lên!", "前进时间到")],
    tips: ["Giá Lạnh cộng hưởng với nội tại làm chậm, tăng khả năng thả diều.", "Nhanh Không Thể Phá tận dụng chênh lệch tốc độ do nội tại tạo ra."],
    traps: ["Chọn đúng hướng ngay từ đầu: AP xoay R hoặc hiệu ứng đòn đánh; trộn nửa vời sẽ chậm ngưỡng sức mạnh."],
    alternatives: ["AP R tầm xa", "Đại Pháp Sư — R liên tục", "Chí mạng hiệu ứng"],
    source: "https://lolhaidou.cn/hero/ashe.html",
  },
  {
    id: "fiddlesticks",
    ddragon: "Fiddlesticks",
    name: "Fiddlesticks",
    title: "Nỗi Sợ Viễn Cổ",
    aliases: ["Fiddle", "Bù nhìn"],
    role: "Pháp sư",
    tier: "SSS",
    buildGrade: "S",
    buildName: "Pháp bạo Bão Quạ",
    buildOriginal: "法爆稻草人",
    summary:
      "Dồn toàn bộ sức mạnh vào cú R từ ngoài tầm nhìn, dùng chí mạng phép và xuyên kháng phép để kết thúc giao tranh trước khi đối thủ kịp phản ứng.",
    coreAugments: [a("Găng Bảo Thạch", "珠光护手")],
    items: ["Dịch Bệnh", "Ngọn Lửa Hắc Hóa", "Mũ Phù Thủy Rabadon", "Mặt Nạ Liandry", "Đồng Hồ Cát Zhonya", "Trượng Hư Vô", "Vô Cực Kiếm"],
    prismatic: [a("Nhiệm Vụ: Mũ Phù Thủy Wooglet", "任务：沃格勒特的巫师帽"), a("Eureka", "尤里卡"), a("Ống Dẫn Hỏa Ngục", "炼狱导管"), a("Thi Triển Vang Dội", "回响施放"), a("Ma Thuật Tinh Quái", "精怪魔法")],
    gold: [a("Hộp Nước Pháp Sư", "术士果汁盒"), a("Đến Giờ Sát Lục", "杀戮时间到了"), a("Ác Ma Siêu Phàm", "超凡邪恶"), a("Trói Buộc Tham Lam", "贪欲束缚"), a("Lãi Suất Thiêu Đốt", "炽燃利息")],
    silver: [a("Nâng Cấp: Zhonya", "升级：中娅"), a("Tư Duy Pháp Sư", "巫师式思考"), a("Chiêu Cuối Bất Khả Cản", "终极不可阻挡"), a("Đừng Ngừng Vận Sức", "别停止引导"), a("Kế Hoạch Đào Thoát", "逃跑计划")],
    tips: ["Nâng Cấp Zhonya cho phép di chuyển trong trạng thái vàng sau khi mở R, vừa sống sót vừa gây đủ sát thương.", "Học Viện Hề cho phép nối tàng hình sau R để tiếp tục thiêu đốt."],
    traps: ["Vòng Tròn Tử Thần có thể làm lộ vị trí trong bụi do hồi máu của bản thân cũng gây sát thương.", "Không Thể Chạm Tới kích hoạt quá sớm khi bắt đầu R; lúc lao ra hiệu ứng vô địch có thể đã hết."],
    alternatives: ["Q kết liễu", "Ống Dẫn Hỏa Ngục"],
    source: "https://lolhaidou.cn/hero/fiddlesticks.html",
  },
  {
    id: "vladimir",
    ddragon: "Vladimir",
    name: "Vladimir",
    title: "Thần Chết Đỏ",
    aliases: ["Vlad", "Máu"],
    role: "Pháp sư",
    tier: "SSS",
    buildGrade: "S",
    buildName: "Pháp sư chống chịu",
    buildOriginal: "法坦流",
    summary:
      "Nội tại đổi SMPT thành máu và máu thành SMPT. Xây chống chịu vẫn có lượng sát thương tốt, đặc biệt khi ghép lõi tăng máu và hồi phục.",
    coreAugments: [a("Nhiệm Vụ: Tôi Luyện Trái Tim", "任务：钢化你心"), a("Động Cơ Xe Tăng", "坦克引擎")],
    items: ["Trái Tim Khổng Thần", "Quyền Trượng Ác Thần", "Động Cơ Vũ Trụ", "Mũ Phù Thủy Rabadon", "Lột Xác", "Ngọn Giáo Shojin", "Huyết Giáp Chúa Tể", "Giáp Máu Warmog"],
    prismatic: [a("Eureka", "尤里卡"), a("Trở Về Cơ Bản", "回归基本功"), a("Nhiệm Vụ: Mũ Wooglet", "任务：沃格勒特的巫师帽"), a("Vòng Lặp Vô Hạn", "无限循环往复"), a("Khế Ước Điềm Gở", "不祥契约")],
    gold: [a("Hộp Nước Pháp Sư", "术士果汁盒"), a("Theo Đuổi Hồi Chiêu", "急速之追求"), a("Ác Ma Siêu Phàm", "超凡邪恶"), a("Cậu Bé Vội Vàng", "急急小子"), a("Biến Đổi: Lăng Kính", "质变：棱彩阶")],
    silver: [a("Tư Duy Pháp Sư", "巫师式思考"), a("Vật Lý Thành Phép", "物理转魔法"), a("Giữ Vững", "保持坚定"), a("Ngày Tập Chân", "练腿日"), a("Hỏa Hồ", "火狐")],
    tips: ["Vật Lý Thành Phép có thể khuếch đại vòng chuyển đổi máu–SMPT của nội tại.", "Vòng Tròn Tử Thần cực kỳ hợp: hồi máu đồng thời biến thành sát thương."],
    traps: ["Thói Quen Hút Máu đem lại lợi ích thấp hơn nhiều so với vẻ ngoài đối với Vladimir."],
    alternatives: ["Vật lý thành phép", "Ống Dẫn Hỏa Ngục — W liên tục", "Vòng Tròn Tử Thần"],
    source: "https://lolhaidou.cn/hero/vladimir.html",
  },
];

const curatedById = new Map(curatedChampions.map((champion) => [champion.id, champion]));

export const champions: ChampionGuide[] = generatedChampions.map((generated) => {
  const curated = curatedById.get(generated.id);
  if (!curated) return generated;
  return {
    ...curated,
    ...generated,
    aliases: [...new Set([...generated.aliases, ...curated.aliases])],
  };
});

export { sourceSync };

export const dataDragonVersion = "16.14.1";

export function championIcon(champion: ChampionGuide) {
  return champion.icon ?? `https://ddragon.leagueoflegends.com/cdn/${dataDragonVersion}/img/champion/${champion.ddragon}.png`;
}

export function championSplash(champion: ChampionGuide) {
  return champion.splash ?? `https://ddragon.leagueoflegends.com/cdn/img/champion/splash/${champion.ddragon}_0.jpg`;
}
