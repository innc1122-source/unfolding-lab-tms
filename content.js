// Seed content for the LMS demo: a brand-neutral corporate training pack.
// All people and learning records are fictional. English is primary; *_zh
// fields hold Simplified Chinese translations.

const PROGRAMS = [
  {
    id: "nho",
    title: "New Hire Onboarding",
    title_zh: "新员工入职指南",
    description: "A practical onboarding path covering company culture, data privacy and core compliance duties for every new employee.",
    description_zh: "覆盖企业文化、数据隐私与核心合规义务的实用入职学习路径，适用于每一位新员工。",
    courseIds: ["culture-conduct", "data-privacy", "compliance"],
    passingScore: 80,
    examMcqCount: 8,
    examOpenCount: 1,
    examTimeLimitMinutes: 20,
    defaultDueDays: 30,
    maxAttempts: 0,
    retakeCooldownHours: 0,
    showAnswersAfterExam: true,
  },
];

const COURSES = [
  {
    id: "culture-conduct",
    programId: "nho",
    title: "Culture & Code of Conduct",
    title_zh: "企业文化与行为准则",
    description: "Understand our core values and the standards of conduct that apply to everyone, every day.",
    description_zh: "了解公司的核心价值观，以及适用于每个人、每一天的行为标准。",
    modules: [
      {
        id: "m1",
        title: "Our Core Values",
        title_zh: "我们的核心价值观",
        minutes: 10,
        sections: [
          {
            heading: "Values guide everyday decisions",
            heading_zh: "价值观指引日常决策",
            html: `<p>Our work is guided by four values: integrity, respect, accountability and customer focus. They apply to everyone, in every role, at every level.</p><p>When a decision feels difficult, the values are the first checklist: is it honest, is it fair to the people involved, and would we be comfortable explaining it publicly?</p>`,
            html_zh: `<p>我们的工作以四项价值观为准绳：诚信、尊重、担当与客户为先。它们适用于每个人、每个岗位、每个层级。</p><p>遇到艰难决定时，先用价值观做一次检查：它是否诚实？对相关的人是否公平？如果公开解释，我们是否问心无愧？</p>`,
          },
          {
            heading: "Values are actions, not posters",
            heading_zh: "价值观是行动，不是标语",
            html: `<p>Integrity means doing the right thing even when no one is watching, and owning mistakes early. Respect means treating colleagues, customers and partners with courtesy, whatever their role or background.</p><p>Accountability means delivering what you committed to and speaking up early when you cannot. Customer focus means understanding real needs before proposing solutions.</p>`,
            html_zh: `<p>诚信意味着在无人监督时依然做正确的事，并尽早承认错误。尊重意味着以礼相待每一位同事、客户与合作伙伴，无论其岗位或背景。</p><p>担当意味着兑现承诺，做不到时尽早说明。客户为先意味着先理解真实需求，再提出解决方案。</p>`,
          },
        ],
      },
      {
        id: "m2",
        title: "The Code of Conduct in Daily Work",
        title_zh: "日常工作中的行为准则",
        minutes: 12,
        sections: [
          {
            heading: "A respectful, harassment-free workplace",
            heading_zh: "相互尊重、杜绝骚扰的职场",
            html: `<p>Harassment, discrimination and bullying have no place here — in the office, online, or at work events. Disagree with ideas as directly as you like; treat the people who hold them with courtesy.</p>`,
            html_zh: `<p>骚扰、歧视与霸凌在这里没有任何容身之地 —— 无论是在办公室、线上，还是工作活动中。你可以直率地反对观点，但必须礼貌地对待持有观点的人。</p>`,
          },
          {
            heading: "Speak up — and never retaliate",
            heading_zh: "敢于发声，绝不打击报复",
            html: `<p>If you see behaviour that may violate the Code — harassment, fraud, safety risks — report it to your manager, HR, or the confidential hotline. Anonymous reports are accepted.</p><p>Retaliation against anyone who raises a concern in good faith is itself a serious violation, even if the original concern turns out to be unfounded.</p>`,
            html_zh: `<p>如果你发现可能违反行为准则的情况 —— 骚扰、舞弊、安全隐患 —— 请向你的经理、人力资源部或保密举报热线报告，也可以匿名举报。</p><p>对善意提出问题的人进行打击报复，本身就是严重违规 —— 即使最初的问题最终查无实据。</p>`,
          },
        ],
      },
    ],
  },
  {
    id: "data-privacy",
    programId: "nho",
    title: "Data Privacy Essentials",
    title_zh: "数据隐私基础",
    description: "Learn what personal data is, how to protect it, and what to do when something goes wrong.",
    description_zh: "了解什么是个人数据、如何保护它，以及出现问题时该怎么做。",
    modules: [
      {
        id: "m3",
        title: "Handling Personal Data Responsibly",
        title_zh: "负责任地处理个人数据",
        minutes: 15,
        sections: [
          {
            heading: "What counts as personal data",
            heading_zh: "什么是个人数据",
            html: `<p>Personal data is any information that can identify a person, directly or in combination: names, ID and phone numbers, email and home addresses, photos, location records, payroll and health details.</p><p>Collect only what a task genuinely needs, use it only for the stated purpose, and keep it no longer than the retention schedule allows.</p>`,
            html_zh: `<p>个人数据是指任何能够直接或组合识别出个人的信息：姓名、证件号、电话号码、邮箱和住址、照片、位置记录、薪酬与健康信息等。</p><p>只收集任务真正需要的数据，只用于声明的目的，并且不超过保存期限规定的时间。</p>`,
          },
          {
            heading: "Keep data secure by default",
            heading_zh: "让数据默认处于安全状态",
            html: `<p>Use only approved systems and shared drives; never move personal data through private email, personal chat accounts or personal USB drives. Lock your screen when you step away, and never share your account or passwords.</p>`,
            html_zh: `<p>只使用公司批准的系统与共享盘；绝不通过私人邮箱、个人聊天账号或个人 U 盘传输个人数据。离开座位时锁屏，账号和密码绝不与他人共用。</p>`,
          },
          {
            heading: "When something goes wrong",
            heading_zh: "出现问题时怎么办",
            html: `<p>If you suspect personal data has been lost, leaked or sent to the wrong person, report it to the security or privacy team immediately — do not investigate quietly on your own or wait for a complaint.</p><p>Fast reporting limits the harm, and in many jurisdictions breach notification is a legal obligation with strict deadlines.</p>`,
            html_zh: `<p>如果你怀疑个人数据丢失、泄露或误发给了错误的收件人，请立即报告安全或隐私团队 —— 不要私下悄悄排查，也不要等到有人投诉。</p><p>尽快报告能把损害降到最低；在许多司法辖区，数据泄露通报是有严格时限的法定义务。</p>`,
          },
        ],
      },
    ],
  },
  {
    id: "compliance",
    programId: "nho",
    title: "Compliance Essentials",
    title_zh: "合规必修",
    description: "Master the everyday compliance duties every employee shares: anti-bribery, conflicts of interest and reporting.",
    description_zh: "掌握每位员工共同承担的日常合规义务：反商业贿赂、利益冲突与问题上报。",
    modules: [
      {
        id: "m4",
        title: "Everyday Compliance Duties",
        title_zh: "日常合规义务",
        minutes: 18,
        sections: [
          {
            heading: "Anti-bribery: gifts and hospitality",
            heading_zh: "反商业贿赂：礼品与招待",
            html: `<p>Never offer or accept anything of value to improperly influence a business decision — cash and cash equivalents are always off limits. Modest gifts and meals may be acceptable within policy limits, but must be recorded and approved as required.</p><p>Be especially careful during tenders, negotiations and audits, when even small courtesies can look like improper influence.</p>`,
            html_zh: `<p>绝不为不当影响商业决策而提供或收受任何有价值的东西 —— 现金及现金等价物在任何情况下都被禁止。政策限额内的小额礼品和餐饮可能是允许的，但必须按要求登记并获得批准。</p><p>在招投标、商务谈判和审计期间要格外谨慎：此时即使很小的人情往来，也可能被视为不当影响。</p>`,
          },
          {
            heading: "Conflicts of interest",
            heading_zh: "利益冲突",
            html: `<p>A conflict of interest arises when a personal relationship, investment or outside role could affect — or appear to affect — your judgment at work, such as approving a contract with a supplier owned by a relative.</p><p>Having a conflict is not misconduct; hiding one is. Disclose it to your manager or the compliance team as soon as you notice it, and step out of the related decision.</p>`,
            html_zh: `<p>当私人关系、个人投资或外部兼职可能影响 —— 或看起来可能影响 —— 你在工作中的判断时，就产生了利益冲突，例如审批一份与亲属所控股供应商的合同。</p><p>存在利益冲突本身不是过错，隐瞒才是。一旦发现，应尽快向经理或合规团队申报，并回避相关决策。</p>`,
          },
          {
            heading: "Your duty to report",
            heading_zh: "你的报告义务",
            html: `<p>Every employee shares the duty to report suspected violations — through a manager, the compliance team, or the anonymous hotline. Reports made in good faith are protected from retaliation.</p><p>Never destroy or alter documents connected to a concern or an investigation; preserving records is part of the duty.</p>`,
            html_zh: `<p>报告涉嫌违规行为是每位员工的共同义务 —— 可以通过经理、合规团队或匿名热线进行。善意的报告受到反报复政策保护。</p><p>绝不销毁或篡改与问题或调查相关的文件；妥善保存记录本身就是义务的一部分。</p>`,
          },
        ],
      },
    ],
  },
];

const mcq = (courseId, moduleId, question, question_zh, correct, correct_zh, wrong) => ({
  courseId, moduleId, type: "mcq", question, question_zh,
  options: [
    { text: correct, text_zh: correct_zh, ok: true },
    ...wrong.map(([text, text_zh]) => ({ text, text_zh })),
  ],
  explanation: correct,
  explanation_zh: correct_zh,
});

const QUESTIONS = [
  mcq("culture-conduct", "m1", "Which action best reflects the value of integrity?", "哪种做法最能体现诚信这一价值观？", "Owning up to a mistake early and correcting it.", "尽早承认错误并加以纠正。", [["Hiding a mistake until someone notices.", "把错误藏起来，等别人发现再说。"], ["Blaming a teammate to protect yourself.", "为保护自己而归咎于同事。"], ["Following the rules only when being watched.", "只在有人监督时才遵守规则。"]]),
  mcq("culture-conduct", "m1", "A shortcut would save time but bends a company rule. What should you do?", "有一条捷径能省时间，但会违反公司规定。你应该怎么做？", "Follow the rule and raise the trade-off with your manager.", "遵守规定，并和经理讨论其中的取舍。", [["Take the shortcut quietly this once.", "这一次悄悄走捷径。"], ["Ask a colleague to do it so it is not your problem.", "让同事去做，这样就与你无关。"], ["Assume it is fine as long as nobody notices.", "只要没人发现就当作没问题。"]]),
  mcq("culture-conduct", "m2", "Which behaviour is consistent with a respectful workplace?", "哪种行为符合相互尊重的职场要求？", "Challenging an idea directly while staying courteous to the person.", "直率地质疑观点，同时对当事人保持礼貌。", [["Making jokes about a colleague's background.", "拿同事的出身背景开玩笑。"], ["Spreading rumours about a teammate.", "散布关于同事的流言。"], ["Talking over junior colleagues in meetings.", "在会议上抢话、打断资历浅的同事。"]]),
  mcq("culture-conduct", "m2", "A colleague tells you they are being harassed. What is the right first step?", "同事告诉你自己正遭受骚扰。正确的第一步是什么？", "Support them in reporting it through official channels.", "支持并协助对方通过官方渠道报告。", [["Promise to keep it a secret.", "承诺替对方保守秘密。"], ["Confront the alleged harasser publicly.", "当众与被指控者对质。"], ["Post about the situation on social media.", "把事情发到社交媒体上。"]]),
  mcq("data-privacy", "m3", "Which of the following is personal data?", "以下哪项属于个人数据？", "An employee's name together with their mobile number.", "员工姓名加上其手机号码。", [["Fully anonymized aggregate statistics.", "完全匿名化的汇总统计数据。"], ["A public product price list.", "公开的产品价目表。"], ["The company's registered office address.", "公司的注册办公地址。"]]),
  mcq("data-privacy", "m3", "What does data minimization mean in practice?", "数据最小化在实践中是什么意思？", "Collect and keep only the personal data needed for a clear purpose.", "只收集并保留明确目的所需的个人数据。", [["Collect everything in case it is useful later.", "尽量多收集，以备日后可能有用。"], ["Keep all data forever so nothing is lost.", "永久保存所有数据以免丢失。"], ["Share data widely so every team has a copy.", "广泛共享数据，让每个团队都留一份。"]]),
  mcq("data-privacy", "m3", "Which practice keeps customer data secure?", "哪种做法能保障客户数据安全？", "Sharing files only through approved company systems with access controls.", "只通过带访问控制的公司批准系统共享文件。", [["Emailing files to your personal mailbox to work from home.", "把文件发到私人邮箱以便在家办公。"], ["Writing passwords on a note by your desk.", "把密码写在便签上贴在桌旁。"], ["Lending your account to a teammate for convenience.", "为图方便把账号借给同事使用。"]]),
  mcq("data-privacy", "m3", "You suspect a file of customer data went to the wrong recipient. What should you do first?", "你怀疑一份客户数据文件被误发给了错误的收件人。首先应该做什么？", "Report it immediately to the security or privacy team.", "立即报告安全或隐私团队。", [["Delete the email and hope nothing happens.", "删掉邮件，指望不会出事。"], ["Wait to see whether anyone complains.", "先等等，看是否有人投诉。"], ["Ask the recipient privately to keep it quiet.", "私下请收件人保密不声张。"]]),
  mcq("compliance", "m4", "Which situation most likely creates a conflict of interest?", "哪种情形最可能构成利益冲突？", "Approving a contract with a supplier owned by your close relative.", "审批一份与你近亲属所控股供应商的合同。", [["Attending a public industry conference.", "参加公开的行业会议。"], ["Buying company products at the staff discount.", "以员工折扣购买公司产品。"], ["Taking a training course paid for by the company.", "参加公司出资的培训课程。"]]),
  mcq("compliance", "m4", "Under the anti-bribery rules, which gift is acceptable?", "根据反商业贿赂规定，哪种礼品是可以接受的？", "A modest gift within policy limits, recorded and approved as required.", "政策限额内、按要求登记并获批准的小额礼品。", [["Cash from a supplier bidding for a contract.", "正在投标的供应商送的现金。"], ["Paid travel from a vendor during a negotiation.", "谈判期间供应商承担费用的旅行。"], ["Any gift, as long as it is kept secret.", "任何礼品，只要保密不声张即可。"]]),
  mcq("compliance", "m4", "You discover a possible compliance violation. What should you do?", "你发现了可能的合规违规行为。应该怎么做？", "Report it promptly through your manager, compliance or the hotline.", "及时通过经理、合规团队或举报热线报告。", [["Ignore it because it is not your department.", "事不关己，置之不理。"], ["Handle it quietly yourself without telling anyone.", "自己悄悄处理，不告诉任何人。"], ["Wait for someone else to report it first.", "等别人先去报告。"]]),
  mcq("compliance", "m4", "Who does the non-retaliation policy protect?", "反报复政策保护的是哪些人？", "Anyone who reports a concern in good faith.", "任何善意报告问题的人。", [["Only managers and executives.", "只有经理和高管。"], ["Only reports that are proven correct.", "只有最终查证属实的报告。"], ["People who spread anonymous rumours.", "散布匿名谣言的人。"]]),
  {
    courseId: "culture-conduct", moduleId: "m2", type: "open",
    question: "Describe a situation where you would use the speak-up channels, and how you would raise the concern.",
    question_zh: "描述一个你会使用发声（举报）渠道的情境，以及你会如何提出这个问题。",
    rubric: "A strong answer names a concrete conduct concern, chooses an appropriate channel (manager, HR or hotline), reports facts promptly without exaggeration, and notes that good-faith reporters are protected from retaliation.",
    rubric_zh: "高分答案会给出一个具体的行为准则问题，选择合适的渠道（经理、人力资源或热线），及时、如实、不夸大地报告，并指出善意报告者受反报复政策保护。",
    maxPoints: 10,
  },
  {
    courseId: "data-privacy", moduleId: "m3", type: "open",
    question: "A customer asks your team to delete their personal data. Outline the steps you would take.",
    question_zh: "一位客户要求你的团队删除其个人数据。请列出你会采取的步骤。",
    rubric: "A strong answer verifies the requester's identity, involves the privacy team, locates the data across systems and backups, checks legal retention obligations before deleting, and confirms completion to the customer with a record kept.",
    rubric_zh: "高分答案包含核实请求者身份、联动隐私团队、在各系统与备份中定位数据、删除前核对法定保存义务，并在完成后向客户确认且留存处理记录。",
    maxPoints: 10,
  },
  {
    courseId: "compliance", moduleId: "m4", type: "open",
    question: "A supplier offers you concert tickets while a tender is in progress. Explain what you would do and why.",
    question_zh: "招标进行期间，一家供应商送你演唱会门票。说明你会怎么做，以及为什么。",
    rubric: "A strong answer declines the tickets or seeks prior approval, cites the gift and anti-bribery policy, discloses the offer to the manager or compliance team, and recognises that an active tender makes even small gifts high-risk.",
    rubric_zh: "高分答案会婉拒门票或事先申请批准，引用礼品与反贿赂政策，向经理或合规团队披露此事，并意识到招标期间即使小礼品也属高风险。",
    maxPoints: 10,
  },
  {
    courseId: "compliance", moduleId: "m4", type: "multi",
    question: "Which actions help keep the company compliant? (Select all that apply.)",
    question_zh: "以下哪些做法有助于公司保持合规？（多选）",
    options: [
      { text: "Declining gifts that could influence a business decision", text_zh: "拒绝可能影响商业决策的礼品", ok: true },
      { text: "Disclosing a conflict of interest as soon as you notice it", text_zh: "一发现利益冲突就及时申报", ok: true },
      { text: "Deleting records related to an ongoing investigation", text_zh: "删除与正在进行的调查相关的记录" },
      { text: "Reporting suspected violations even when it feels inconvenient", text_zh: "即使不方便也报告涉嫌违规的行为", ok: true },
    ],
    explanation: "Compliance depends on refusing improper benefits, disclosing conflicts and reporting promptly; destroying investigation records is itself a serious violation.",
    explanation_zh: "合规依靠拒绝不当利益、申报冲突和及时报告；销毁调查记录本身就是严重违规。",
  },
  {
    courseId: "culture-conduct", moduleId: "m1", type: "fill",
    question: "Owning your commitments and your mistakes reflects the core value of ______.",
    question_zh: "对自己的承诺和错误负责，体现的核心价值观是 ______。",
    answers: ["accountability", "ownership", "担当", "责任"],
    explanation: "Accountability means delivering what you committed to and owning mistakes early.",
    explanation_zh: "担当意味着兑现承诺，并尽早承认错误。",
  },
];

module.exports = { PROGRAMS, COURSES, QUESTIONS };
