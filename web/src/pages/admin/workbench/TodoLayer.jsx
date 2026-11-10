// 12.2 工作台 第一层「需要处理」（b12-design §6.4）：运营待办，按严重度 → 截止日 → 数量排序。
// 每行：事项（左）、数量与截止日（右），「查看名单」打开名单整页，「去处理」进对应业务页。
// 390 宽：文字在左、数量与截止日在右，按钮换到下一行右对齐（版式在 W3.css .wb-todo-row）。
import { useNavigate } from 'react-router-dom';
import { date as fmtDate } from '../../../fmt.js';   // 一致性整改 3
import { Banner } from '@douyinfe/semi-ui';
import { useI18n } from '../../../i18n.jsx';
import { severityOrder, todoVisible, safeAdminLink } from '../../../workbench.js';
import { nf, ListLink, IcArrow } from './shared.jsx';

const T = {
  zh: {
    items: {
      probationDue: '试用期 30 天内到期、尚未发起转正评估',
      reviewSelfOverdue: '自评已逾期',
      reviewRateOverdue: '上级评级已逾期',
      reviewHrConfirm: '部门校准待 HR 确认',
      appealsDue: '绩效申诉已逾期或即将到期',
      trainingOverdue: '必修培训已逾期',
      trainingDueSoon: '必修培训 7 天内到期',
      approvals: '选修申请与发展项目提名待审批',
      grading: '答卷待评分或复核',
      noJobLevel: '在职员工未设职级',
      noManager: '在职员工未设直属上级',
      deptNoHrbp: '部门未配置 HRBP',
      cultureMeetings: '本周 3+3 例会未登记',
      cultureCards: '认可卡待审核',
    },
    other: '其他待办',
    overdue: '已逾期', soon: '即将到期',
    due: (d) => `截止 ${d}`,
    overdueOf: (n) => `其中 ${n} 项已逾期`,
    gradingLate: (n) => `其中 ${n} 份超过 3 个工作日`,
    go: '去处理', empty: '当前没有需要处理的事项。',
    loadFail: '待办加载失败，请刷新页面重试。',
  },
  en: {
    items: {
      probationDue: 'Probation ending within 30 days, regularization review not started',
      reviewSelfOverdue: 'Self-reviews overdue',
      reviewRateOverdue: 'Manager ratings overdue',
      reviewHrConfirm: 'Department calibrations awaiting HR confirmation',
      appealsDue: 'Performance appeals overdue or due soon',
      trainingOverdue: 'Required training overdue',
      trainingDueSoon: 'Required training due within 7 days',
      approvals: 'Elective requests and development program nominations awaiting approval',
      grading: 'Exam submissions awaiting grading or review',
      noJobLevel: 'Active employees without a job level',
      noManager: 'Active employees without a direct manager',
      deptNoHrbp: 'Departments without an HRBP',
      cultureMeetings: '3+3 meetings not logged this week',
      cultureCards: 'Recognition cards awaiting review',
    },
    other: 'Other action item',
    overdue: 'Overdue', soon: 'Due soon',
    due: (d) => `Due ${d}`,
    overdueOf: (n) => `${n} overdue`,
    gradingLate: (n) => `${n} waiting over 3 working days`,
    go: 'Take action', empty: 'Nothing needs action right now.',
    loadFail: 'Couldn’t load action items. Refresh the page to try again.',
  },
};

/** 第一层可见条目（服务端条目 + 3+3 前端条目，按视角隐藏、只留数量 > 0 的，排序）。 */
export function todoRows(items, cultureItems, layout) {
  return severityOrder([...(items || []), ...(cultureItems || [])].filter((x) => x && Number(x.count) > 0 && todoVisible(x, layout)));
}

function GoButton({ link, label }) {
  const navigate = useNavigate();
  if (!link) return null;
  const admin = safeAdminLink(link);
  // 3+3 后台是整页外链（/culture/#/hr，服务端静态挂载），不在本 SPA 的路由里
  const external = !admin && /^\/culture\//.test(link) ? link : null;
  if (!admin && !external) return null;
  return (
    <button type="button" className="btn sm wb-go" onClick={() => (admin ? navigate(admin) : window.location.assign(external))}>
      {label}<IcArrow />
    </button>
  );
}

export default function TodoLayer({ rows, error }) {
  const { lang } = useI18n();
  const s = T[lang] || T.en;
  if (error) return <Banner type="danger" closeIcon={null} description={s.loadFail} />;
  if (!rows.length) return <div className="wb-empty">{s.empty}</div>;
  return (
    <ul className="wb-todo">
      {rows.map((x, i) => {
        const late = Number(x.overdueCount) > 0 ? (x.key === 'grading' ? s.gradingLate(nf(Number(x.overdueCount))) : s.overdueOf(nf(Number(x.overdueCount)))) : null;
        return (
          <li className={'wb-todo-row ' + (x.severity || 'normal')} key={x.key + ':' + i}>
            <div className="wb-todo-main">
              <span className="wb-todo-text">{s.items[x.key] || s.other}</span>
              {x.severity === 'overdue' && <span className="pill fail">{s.overdue}</span>}
              {x.severity === 'soon' && <span className="pill warn">{s.soon}</span>}
              {late && <span className="wb-todo-sub">{late}</span>}
            </div>
            <div className="wb-todo-side">
              {x.dueOn && <span className="wb-todo-due tnum">{s.due(fmtDate(x.dueOn))}</span>}
              <span className="wb-todo-count tnum">{nf(Number(x.count))}</span>
            </div>
            <div className="wb-todo-act">
              {x.drill && <ListLink drill={x.drill} to={x.link} />}
              <GoButton link={x.link} label={s.go} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
