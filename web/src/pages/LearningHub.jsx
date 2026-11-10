import { Link } from 'react-router-dom';
import { useI18n } from '../i18n.jsx';
import { useAuth } from '../auth.jsx';
import { useLearningNav } from '../learningnav.js';
import ModuleTrail from '../components/ModuleTrail.jsx';

// 「培训」中转页（IA 1.3，路由 /learn，受 on('learning') 保护）：手机底栏「培训」与页头模块路径第一段都到这里。
// 入口与顶栏「培训▾」下拉同一张表（learningnav.js），兼任讲师、班主任、经理的人能看到全部入口。
const T = {
  zh: { title: '培训', lead: '课程、发展项目，以及讲师、班主任和经理的培训工作入口' },
  en: { title: 'Learning', lead: 'Courses, development programs, and tools for trainers, class coordinators and managers' },
};

export default function LearningHub() {
  const { lang } = useI18n();
  const { user } = useAuth();
  const s = T[lang] || T.en;
  const { items } = useLearningNav(user);
  return (
    <div className="wrap">
      <ModuleTrail items={[{ label: s.title }]} />
      <div className="ml-head">
        <h1 className="ml-title">{s.title}</h1>
        <p className="ml-lead">{s.lead}</p>
      </div>
      <div className="hub-grid">
        {items.map((it) => (
          <Link key={it.id} to={it.to} className="hub-card" data-learning-item={it.id}>
            <span className="hub-card-t">{lang === 'zh' ? it.zh : it.en}</span>
            <span className="hub-card-d">{lang === 'zh' ? it.hubZh : it.hubEn}</span>
            <svg className="ic sm hub-card-go" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
          </Link>
        ))}
      </div>
    </div>
  );
}
