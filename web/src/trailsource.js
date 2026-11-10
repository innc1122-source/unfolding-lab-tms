// 页头模块路径按来源显示（IA 1.4 注 1、D-29 ①）：从培养项目进入课程、学习内容、考试说明、答题与考试结果时，路径为
// 「培训 › 培养项目 › 〈项目名〉 › 〈课程名〉 …」，学员能直接返回项目；没有来源时按「培训 › 课程 › …」（D-29 缺省 ②）。
// 来源写在地址的查询参数 ?from=project:<id>（HashRouter 下为 #/course/x?from=project:y），刷新页面与逐页跳转都能保留；
// 各页跳到下一页时用 withFrom() 带上。项目名取「我的培养项目」接口（tprojects.js 已有 30 秒缓存）；取不到时这一段省略。
import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { fetchMyProjects } from './tprojects.js';
import { learnTrail } from './components/ModuleTrail.jsx';

const FROM_RE = /^project:([\w-]{1,80})$/;

/** 当前地址里的来源：{ kind: 'project', id } 或 null */
export function readTrailSource(search) {
  const v = new URLSearchParams(search || '').get('from');
  const m = v && FROM_RE.exec(v);
  return m ? { kind: 'project', id: m[1] } : null;
}

/** 给站内路径带上来源（没有来源时原样返回） */
export function withFrom(path, src) {
  if (!src || src.kind !== 'project') return path;
  return path + (path.includes('?') ? '&' : '?') + 'from=' + encodeURIComponent('project:' + src.id);
}

/** 页面用：{ src, head(lang, loc) }。head 给出课程之前的几段（「培训 › 课程」或「培训 › 培养项目 › 〈项目名〉」） */
export function useTrailSource() {
  const { search } = useLocation();
  const src = readTrailSource(search);
  const [proj, setProj] = useState(null);
  const pid = src && src.id;
  useEffect(() => {
    let alive = true;
    if (!pid) { setProj(null); return undefined; }
    fetchMyProjects().then((d) => { if (alive) setProj(((d && d.mine) || []).find((p) => p.id === pid) || null); }).catch(() => {});
    return () => { alive = false; };
  }, [pid]);
  const head = (lang, loc) => {
    if (!src) return learnTrail(lang, 'courses');
    const base = learnTrail(lang, 'programs');
    return proj ? [...base, { label: loc(proj, 'title'), to: '/projects/' + proj.id }] : base;
  };
  return { src, head };
}
