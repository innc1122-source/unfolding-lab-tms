// 生成题库批量导入模板 question-import-template.xlsx（中英文分列）。
//
//   cd web && ..\runtime\node.exe scripts\question-template.mjs
//
// 写两份：
//   web/public/templates/question-import-template.xlsx —— 源文件。vite 的 publicDir 是 web/public，
//     `vite build` 会把它原样拷进 public/dist/templates/，所以构建清空 dist 后模板也会回来。
//   public/dist/templates/question-import-template.xlsx —— 当前线上读取的那份，免得非得重新构建才生效。
//
// 表头取自 src/pages/admin/questionImport.js 的 IMP_TEMPLATE_HEADERS，与解析器是同一份定义；
// test/question-import.test.js 会读回生成的文件，用解析器逐行检查示例题都能导入。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import XLSX from 'xlsx';
import { IMP_TEMPLATE_HEADERS } from '../src/pages/admin/questionImport.js';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTS = [
  path.join(WEB, 'public', 'templates', 'question-import-template.xlsx'),
  path.join(WEB, '..', 'public', 'dist', 'templates', 'question-import-template.xlsx'),
];

// 一题一行：[题型, 题干中, 题干英, [选项A中, 选项A英], …(最多 12 组 A–L), 正确答案, 解析中, 解析英, 分值, 案例编号, 分类中, 分类英]
// 第四批 6.1（2026-10-08）：选项扩到 A–L；新增「案例编号」「分类」两组列；示例补上排序 / 匹配 / 分类 / 多空填空 / 案例。
// 末尾三列不填的行由 ROWS 补空。
const opt = (...pairs) => { const out = []; for (let i = 0; i < 12; i++) out.push(...(pairs[i] || ['', ''])); return out; };
const tail = (caseId = '', catsZh = '', catsEn = '') => [caseId, catsZh, catsEn];
const EXAMPLES = [
  ['单选', '下列哪项属于洗钱行为？', 'Which of the following is money laundering?',
    ...opt(['用非法所得购买房产并转售', 'Buying and reselling property with illegal proceeds'], ['正常工资入账', 'Receiving a normal salary'], ['缴纳个人所得税', 'Paying personal income tax'], ['银行定期存款', 'Keeping a bank time deposit']),
    'A', '洗钱是将非法所得合法化的行为', 'Money laundering makes illegal proceeds look legitimate.', ''],
  ['多选', '以下哪些属于客户尽职调查（CDD）的内容？', 'Which of these are part of customer due diligence (CDD)?',
    ...opt(['核实客户身份', 'Verify the customer\'s identity'], ['了解资金来源', 'Understand the source of funds'], ['帮客户隐匿资产', 'Help the customer hide assets'], ['持续交易监控', 'Ongoing transaction monitoring']),
    'ABD', '', '', ''],
  ['判断', '员工可以私下接受供应商的大额礼品。', 'Employees may privately accept expensive gifts from suppliers.',
    ...opt(), '错', '违反利益冲突政策', 'This breaches the conflict-of-interest policy.', ''],
  ['填空', '反洗钱的英文缩写是____。', 'The abbreviation for anti-money laundering is ____.',
    ...opt(), 'AML|Anti-Money Laundering|反洗钱', '多个可接受答案用 | 分隔', 'Separate accepted answers with |', ''],
  ['问答', '请简述发现可疑交易后的上报流程。', 'Briefly describe how to report a suspicious transaction.',
    ...opt(), '', '要点：立即记录；报告直属上级与合规部；不得向客户透露；配合后续调查', 'Key points: record it at once; report to your manager and Compliance; do not tip off the customer; cooperate with the follow-up.', '10'],
  ['单选', '公司反洗钱政策由哪个部门负责？', '',
    ...opt(['合规部', ''], ['市场部', ''], ['行政部', '']),
    'A', '', '', ''],
  ['排序', '发现可疑交易后的处理步骤依次是？', 'Put the steps for handling a suspicious transaction in order.',
    ...opt(['记录交易细节', 'Record the transaction details'], ['报告直属上级与合规部', 'Report to your manager and Compliance'], ['配合合规部调查', 'Cooperate with the Compliance review']),
    '', '选项按正确顺序填写；考试时自动打乱', 'Enter the steps in the correct order; they are shuffled in the exam.', ''],
  ['匹配', '将术语与含义配对。', 'Match each term to its meaning.',
    ...opt(['KYC => 了解你的客户', 'KYC => Know your customer'], ['CDD => 客户尽职调查', 'CDD => Customer due diligence'], ['STR => 可疑交易报告', 'STR => Suspicious transaction report'], ['=> 现金交易报告', '=> Cash transaction report']),
    '', '最后一项只有右项，是干扰项', 'The last item has no left side, so it is a distractor.', ''],
  ['分类', '将下列行为归入正确类别。', 'Sort each action into the right category.',
    ...opt(['拆分大额存款 => 可疑', 'Splitting a large deposit => Suspicious'], ['按时发放工资 => 正常', 'Paying salaries on time => Normal'], ['频繁跨境小额汇款 => 可疑', 'Frequent small cross-border transfers => Suspicious'], ['缴纳水电费 => 正常', 'Paying utility bills => Normal']),
    '', '', '', '', ...tail('', '可疑 | 正常', 'Suspicious | Normal')],
  ['多空填空', '客户尽职调查的英文缩写是 {{1}}，可疑交易报告的英文缩写是 {{2}}。', 'Customer due diligence is abbreviated {{1}}, and a suspicious transaction report {{2}}.',
    ...opt(), '1: CDD ; 2: STR | SAR', '空与空之间用分号，同一空的多个答案用 |', 'Separate blanks with ; and accepted answers with |.', '2'],
  ['案例', '某客户在一周内分三次存入现金，每次略低于申报门槛，并要求不要留下记录。', 'A customer deposits cash three times in one week, each just under the reporting threshold, and asks that no record be kept.',
    ...opt(), '', '', '', '', ...tail('C1')],
  ['单选', '这种做法最可能属于？', 'What is this behaviour most likely to be?',
    ...opt(['拆分交易（结构化）', 'Structuring'], ['正常理财', 'Normal money management']),
    'A', '', '', '', ...tail('C1')],
  ['判断', '员工可以答应客户不留记录。', 'The employee may agree not to keep a record.',
    ...opt(), '错', '', '', '', ...tail('C1')],
];
const ROWS = EXAMPLES.map((r) => [...r, ...new Array(Math.max(0, IMP_TEMPLATE_HEADERS.length - r.length)).fill('')]);

const NOTES = [
  ['题库批量导入模板 · Question bank import template'],
  [''],
  ['必填列：题型；题干至少填一种语言（「题干(中文)」或「Stem (EN)」）。示例行请删除后再填写。'],
  ['中英文分列：题干、选项 A–L、解析、分类各有「(中文)」与「(EN)」两列，分别导入题目的中文与英文内容；学员按界面语言看到对应版本，缺哪种语言就显示另一种。'],
  ['只填中文或只填英文都可以；同一题最好两种语言的选项一一对应（选项A(中文) 与 Option A (EN) 是同一个选项）。'],
  ['题型可填：单选 / 多选 / 判断 / 填空 / 多空填空 / 排序 / 匹配 / 分类 / 问答 / 案例。'],
  ['单选、多选：选项写在 选项A–L（至少两个）；「正确答案」填字母，如 A 或 ACD（不分语言）。'],
  ['判断：不用填选项，「正确答案」填 对 或 错（也可填 正确 / 错误、T / F、True / False）。'],
  ['排序：3–8 个步骤按正确顺序写在选项A 起的各列，考试时自动打乱；「正确答案」可留空，选项乱序时填字母顺序（如 CADB）。'],
  ['匹配：每个选项格写「左项 => 右项」（中英文两列各写一份），2–8 对；干扰项写「=> 右项」，最多 3 个；右项不能重复。'],
  ['分类：类别写在「分类(中文)」「Categories (EN)」两列，用 | 分隔（2–5 类，中英文按位置对应）；每个选项格写「项目 => 类别名」，类别名须与同一语言的类别一致；每个类别至少一个项目。'],
  ['多空填空：题干里用 {{1}}、{{2}}… 标出空格（中英文题干都要标）；「正确答案」写 1: 答案 ; 2: 答案，同一空的多个可接受答案用 | 分隔。'],
  ['案例（情境案例题组）：题型填「案例」，题干填案例材料，「案例编号」填如 C1；紧接其后「案例编号」相同的 2–8 行是它的小题，小题可以是除问答、案例外的任何题型，各自的「分值」是小题分值。'],
  ['填空：「正确答案」填可接受的答案，中英文答案都写进去，用 | 分隔（如 AML|Anti-Money Laundering|反洗钱）。'],
  ['问答：评分要点写在「解析(中文)」/「Explanation (EN)」列；「分值」默认 10 分。系统由 AI 按要点辅助判分，HR 可复核改分。'],
  ['解析列选填：考试后向员工展示（若该考试开启了显示答案）。'],
  ['旧模板（题目 / 选项A / 解析 单语列）仍可导入，按中文内容处理。'],
  ['分值：每题分值，1–100 的整数，留空 = 按考试的题型默认分值；问答题的「分值」是评分满分（默认 10）。'],
  ['每次最多导入 200 题（一组案例连同小题算 1 题）。'],
  ['后台 → 题库 →「导出题库」导出的文件就是本模板的版式，改好后可以直接导入。'],
  [''],
  ['使用方法：'],
  ['1. 删除示例行，从第 2 行开始填写。'],
  ['2. 登录后台 → 题库 → 批量导入 → 选择目标课程 → 上传本文件。'],
  ['3. 核对预览（中英文题干分两行显示；有问题的行会标红并说明原因），点「确认导入」。'],
];

const ws = XLSX.utils.aoa_to_sheet([IMP_TEMPLATE_HEADERS, ...ROWS]);
ws['!cols'] = IMP_TEMPLATE_HEADERS.map((h) => ({ wch: /题干|Stem/.test(h) ? 36 : /分类|Categories|案例|Case/.test(h) ? 18 : /解析|Explanation/.test(h) ? 30 : /选项|Option/.test(h) ? 20 : 10 }));
ws['!freeze'] = { xSplit: 0, ySplit: 1 };
const notes = XLSX.utils.aoa_to_sheet(NOTES);
notes['!cols'] = [{ wch: 110 }];
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, '题目');
XLSX.utils.book_append_sheet(wb, notes, '填写说明');

for (const out of OUTS) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  XLSX.writeFile(wb, out);
  console.log('wrote', path.relative(path.join(WEB, '..'), out));
}
