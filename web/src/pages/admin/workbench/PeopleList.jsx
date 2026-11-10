// 12.2 工作台 名单整页（b12-design §1.4，负责人规则：不用抽屉，长内容用整页）。
// 工作台路由 /admin 带 ?list=<metric>&dept=&cell=&stage=&period=&to= 时显示本页；浏览器返回即回到工作台。
// 数据：GET /api/admin/workbench/people —— 与卡片数字同一函数产出的主体集合（计数 = total）。主体不是人时（关键岗位、部门、周期阶段），
// 每行是岗位或部门。行字段只取已知字段（姓名、工号、部门、岗位、职级与该指标的 1–3 个字段），其余忽略。
// ≥ 768 为表格；< 768 每行一张卡片，不横向滚动。名单最多 500 行，超出时提示已截断。
import { useNavigate } from 'react-router-dom';
import { date as fmtDate } from '../../../fmt.js';
import { Banner, Spin } from '@douyinfe/semi-ui';
import { api, useAsync } from '../../../api.js';
import { useI18n } from '../../../i18n.jsx';
import { drillQuery, safeAdminLink } from '../../../workbench.js';
import { nf, usePhone, IcArrow, IcBack } from './shared.jsx';

// 名单标题：指标键 → 文案（dept.<列> 与 nineBox 另行拼接）
const T = {
  zh: {
    back: '返回工作台', go: '去处理', total: (n) => `共 ${n} 条`,
    truncated: (n) => `只显示前 ${n} 条，完整名单请在对应业务页查看。`,
    empty: '名单为空。', loadFail: '名单加载失败。', notFound: '该名单不存在，或你的角色无权查看。',
    titles: {
      succession: '关键岗位继任覆盖', retention: '本季度离职的高潜与关键人才', flight: '当前被标记流失风险的员工',
      compliance: '本期未完成必修培训的员工', reviewOnTime: '逾期完成或未完成的评估阶段', probation: '本季度试用期转正结论',
      span: '管理幅度异常的管理者', nineBox: '九宫格名单',
      probationDue: '试用期 30 天内到期、尚未发起转正评估', reviewSelfOverdue: '自评已逾期', reviewRateOverdue: '上级评级已逾期',
      reviewHrConfirm: '部门校准待 HR 确认', appealsDue: '绩效申诉已逾期或即将到期', trainingOverdue: '必修培训已逾期',
      trainingDueSoon: '必修培训 7 天内到期', approvals: '待审批的申请与提名', grading: '待评分或复核的答卷',
      noJobLevel: '未设职级的在职员工', noManager: '未设直属上级的在职员工', deptNoHrbp: '未配置 HRBP 的部门',
    },
    deptCol: (c) => `部门健康度：${c}`,
    cols: { headcount: '在职人数', probation: '试用期占比', compliance: '必修完成率', reviewOnTime: '评估按时率', hipo: '高潜占比' },
    list: '名单',
    f: {
      name: '姓名', position: '岗位', deptName: '部门', employeeId: '工号', department: '部门', jobLevel: '职级',
      dueOn: '截止日', overdueDays: '逾期天数', stage: '阶段', completedOn: '完成日', readiness: '就绪度',
      successors: '继任者总数', readySuccessors: '就绪继任者', topReadiness: '最高就绪度', exitDate: '离职日', exitType: '离职类型',
      tags: '人才标签', taggedOn: '打标日期', taggedBy: '打标人', hireDate: '入职日', decidedOn: '结论日', result: '结论',
      directs: '直属人数', anomaly: '异常类型', missingCount: '未完成门数', earliestDue: '最早截止日', count: '数量', headcount: '在职人数',
    },
    v: {
      self: '自评', rate: '上级评级', calib: 'HoD 校准', ready: '即刻就绪', oneYear: '1–2 年内就绪', twoYears: '2 年以上就绪',
      'On time': '按期转正', Extended: '延期转正', Failed: '未通过',
      // CX-138：转正名单的 result 是 workbench.js 的规范值（onTime / extended / failed / exitedInProbation）
      onTime: '按期转正', extended: '延期转正', failed: '未通过', exitedInProbation: '试用期内离职',
      Voluntary: '主动离职', Involuntary: '被动离职', 'Contract end': '合同到期', zero: '直属 0 人', over: '超过上限',
      notDone: '未完成',
    },
  },
  en: {
    back: 'Back to Dashboard', go: 'Take action', total: (n) => `${n} in total`,
    truncated: (n) => `Showing the first ${n}. Open the related page for the full list.`,
    empty: 'This list is empty.', loadFail: 'Couldn’t load the list.', notFound: 'This list doesn’t exist, or your role can’t view it.',
    titles: {
      succession: 'Key Position Succession Coverage', retention: 'High-Potential & Key Talent Exits This Quarter', flight: 'Employees Currently Flagged Flight Risk',
      compliance: 'Employees With Incomplete Required Training', reviewOnTime: 'Review Stages Completed Late or Not Completed', probation: 'Probation Outcomes This Quarter',
      span: 'Managers With Span-of-Control Exceptions', nineBox: '9-Box List',
      probationDue: 'Probation Ending Within 30 Days, Review Not Started', reviewSelfOverdue: 'Overdue Self-Reviews', reviewRateOverdue: 'Overdue Manager Ratings',
      reviewHrConfirm: 'Department Calibrations Awaiting HR Confirmation', appealsDue: 'Performance Appeals Overdue or Due Soon', trainingOverdue: 'Overdue Required Training',
      trainingDueSoon: 'Required Training Due Within 7 Days', approvals: 'Requests and Nominations Awaiting Approval', grading: 'Submissions Awaiting Grading or Review',
      noJobLevel: 'Active Employees Without a Job Level', noManager: 'Active Employees Without a Direct Manager', deptNoHrbp: 'Departments Without an HRBP',
    },
    deptCol: (c) => `Department health: ${c}`,
    cols: { headcount: 'Active headcount', probation: 'On probation', compliance: 'Required training', reviewOnTime: 'On-time reviews', hipo: 'High-potential share' },
    list: 'List',
    f: {
      name: 'Name', position: 'Position', deptName: 'Department', employeeId: 'Employee ID', department: 'Department', jobLevel: 'Job level',
      dueOn: 'Due date', overdueDays: 'Days overdue', stage: 'Stage', completedOn: 'Completed on', readiness: 'Readiness',
      successors: 'Successors', readySuccessors: 'Ready successors', topReadiness: 'Highest readiness', exitDate: 'Exit date', exitType: 'Exit type',
      tags: 'Talent tags', taggedOn: 'Tagged on', taggedBy: 'Tagged by', hireDate: 'Hire date', decidedOn: 'Decision date', result: 'Outcome',
      directs: 'Direct reports', anomaly: 'Exception', missingCount: 'Incomplete courses', earliestDue: 'Earliest due date', count: 'Count', headcount: 'Active headcount',
    },
    v: {
      self: 'Self-review', rate: 'Manager rating', calib: 'HoD calibration', ready: 'Ready now', oneYear: 'Ready in 1–2 years', twoYears: 'Ready in 2+ years',
      'On time': 'Regularized on time', Extended: 'Regularized after extension', Failed: 'Not regularized',
      onTime: 'Regularized on time', extended: 'Regularized after extension', failed: 'Not regularized', exitedInProbation: 'Left during probation',
      Voluntary: 'Voluntary', Involuntary: 'Involuntary', 'Contract end': 'Contract end', zero: 'No direct reports', over: 'Above the limit',
      notDone: 'Not completed',
    },
  },
};

// 每类主体的固定列，其后按行里实际出现的指标字段追加（顺序固定）
const BASE = {
  person: ['employeeId', 'department', 'position', 'jobLevel'],
  position: ['deptName'],
  dept: ['headcount'],
  stage: ['department'],
};
const EXTRA = ['stage', 'dueOn', 'overdueDays', 'completedOn', 'readiness', 'readySuccessors', 'successors', 'topReadiness', 'hireDate', 'decidedOn', 'result',
  'exitDate', 'exitType', 'tags', 'taggedOn', 'taggedBy', 'directs', 'anomaly', 'missingCount', 'earliestDue', 'count'];
const VALUE_MAPPED = new Set(['stage', 'readiness', 'topReadiness', 'result', 'exitType', 'anomaly']);
const MAX_ROWS = 500;

/** 名单列：基础列（只取至少一行有值的）+ 行里出现过的指标字段。 */
export function listColumns(kind, rows) {
  const has = (k) => (rows || []).some((r) => r && r[k] !== undefined && r[k] !== null && r[k] !== '');
  const base = (BASE[kind] || BASE.person).filter((k) => k === 'headcount' || has(k) || (k === 'department' && has('deptName')));
  return [...base, ...EXTRA.filter((k) => !base.includes(k) && has(k))];
}

function fmt(k, v, s) {
  if (v === null || v === undefined || v === '') return k === 'completedOn' ? s.v.notDone : '—';
  if (Array.isArray(v)) return v.join('、');
  if (VALUE_MAPPED.has(k) && s.v[v]) return s.v[v];
  if (typeof v === 'number') return nf(v);
  if (/On$|Date$|Due$/.test(k) && typeof v === 'string') return fmtDate(v);   // 一致性整改 3
  return String(v);
}
const cellVal = (r, k, s) => fmt(k, k === 'department' ? (r.department ?? r.deptName) : r[k], s);

export function listTitle(drill, s) {
  const m = drill.metric || '';
  if (m.startsWith('dept.')) return s.deptCol(s.cols[m.slice(5)] || m.slice(5));
  return s.titles[m] || s.list;
}

export default function PeopleList({ drill, to }) {
  const { lang } = useI18n();
  const s = T[lang] || T.en;
  const navigate = useNavigate();
  const phone = usePhone();
  const qs = drillQuery(drill);
  const q = useAsync(() => api.get(`/api/admin/workbench/people?${qs}`), [qs]);
  const d = q.data;
  const go = safeAdminLink((d && d.link) || to);
  const title = listTitle(drill, s);
  const kind = (d && d.kind) || 'person';
  const rows = (d && d.rows) || [];
  const cols = listColumns(kind, rows);
  const nameOf = (r) => (kind === 'dept' ? (r.deptName || r.name) : r.name) || '—';
  const openRow = (r) => {
    if (kind === 'person' && r.id) navigate(`/admin/people/${encodeURIComponent(r.id)}`);
    else if (kind === 'position' && r.id) navigate(`/admin/talent-review/key-positions?focus=${encodeURIComponent(r.id)}`);
  };
  const clickable = kind === 'person' || kind === 'position';

  return (
    <div className="wb-list">
      <div className="wb-list-top">
        <button type="button" className="btn ghost sm wb-back" onClick={() => navigate('/admin')}><IcBack />{s.back}</button>
        {go && <button type="button" className="btn sm wb-go" onClick={() => navigate(go)}>{s.go}<IcArrow /></button>}
      </div>
      <div className="u-title-line wb-list-head">
        <h1 className="tset-title">{title}</h1>
        {d && <span className="pill pri wb-count tnum">{s.total(nf(Number(d.total) || 0))}</span>}
      </div>
      {q.error ? <Banner type="danger" closeIcon={null} description={q.error.status === 404 ? s.notFound : `${s.loadFail} · ${q.error.message}`} />
        : !d ? <div className="wb-loading"><Spin size="large" /></div>
          : rows.length === 0 ? <div className="wb-empty">{s.empty}</div>
            : (
              <>
                {d.truncated && <Banner type="info" closeIcon={null} className="wb-trunc" description={s.truncated(nf(MAX_ROWS))} />}
                {phone ? (
                  <ul className="wb-lcards">
                    {rows.map((r, i) => (
                      <li className="wb-lcard" key={(r.id || r.deptId || '') + ':' + i}>
                        <div className="wb-lcard-head">
                          {clickable ? <button type="button" className="emp-namelink wb-lname" onClick={() => openRow(r)}>{nameOf(r)}</button> : <span className="wb-lname">{nameOf(r)}</span>}
                          {r.employeeId && <span className="wb-lcard-id tnum">{r.employeeId}</span>}
                        </div>
                        <dl className="wb-lcard-grid">
                          {cols.filter((k) => k !== 'employeeId').map((k) => (
                            <div className="wb-lcard-cell" key={k}><dt>{s.f[k]}</dt><dd className="tnum">{cellVal(r, k, s)}</dd></div>
                          ))}
                        </dl>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="wb-card wb-ltable-wrap">
                    <table className="wb-ltable">
                      <thead>
                        <tr><th scope="col">{kind === 'position' ? s.f.position : kind === 'dept' ? s.f.deptName : s.f.name}</th>{cols.map((k) => <th scope="col" key={k}>{s.f[k]}</th>)}</tr>
                      </thead>
                      <tbody>
                        {rows.map((r, i) => (
                          <tr key={(r.id || r.deptId || '') + ':' + i}>
                            <th scope="row">{clickable ? <button type="button" className="emp-namelink wb-lname" onClick={() => openRow(r)}>{nameOf(r)}</button> : nameOf(r)}</th>
                            {cols.map((k) => <td key={k} className="tnum">{cellVal(r, k, s)}</td>)}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
    </div>
  );
}
