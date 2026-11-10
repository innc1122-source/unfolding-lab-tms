// 富文本编辑器（2026-10-06 负责人：课程正文要有加粗、换行 / 段落、标题、列表等基本格式）。
// 基于 TipTap 3（@tiptap/react + starter-kit，Semi 组件库自带的依赖，已在 web/package.json 显式声明同版本）。
// 输出 HTML：段落 <p>、换行 <br>（Shift+Enter）、<h2>/<h3>、<strong>/<em>/<u>/<s>、<ul>/<ol>/<li>、<blockquote>、<a>、<hr>。
// 服务端 sanitizeHtml 的白名单覆盖这些标签；学员端 .prose 与编辑区共用同一套排版样式（app.css）。
// 受控用法：value（HTML）+ onChange(html)。外部改写 value（如 AI 翻译填入）时编辑器内容随之更新。
import { useEffect, useRef, useState } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Placeholder } from '@tiptap/extensions';
import { Popover, Input, Button } from '@douyinfe/semi-ui';
import { useI18n } from '../i18n.jsx';
import { IcLink } from './LineIcons.jsx';

const T = {
  zh: {
    para: '正文', h2: '标题', h3: '小标题', bold: '加粗（Ctrl+B）', italic: '斜体（Ctrl+I）', underline: '下划线（Ctrl+U）', strike: '删除线',
    bullet: '无序列表', ordered: '有序列表', quote: '引用', link: '链接', hr: '分隔线', undo: '撤销（Ctrl+Z）', redo: '重做（Ctrl+Shift+Z）',
    clear: '清除格式', source: 'HTML 源码', visual: '返回编辑', linkPh: 'https://…', linkOk: '确定', linkRemove: '移除链接',
    tip: 'Enter 新段落，Shift+Enter 换行；可直接粘贴 Word / 飞书内容。',
  },
  en: {
    para: 'Body', h2: 'Heading', h3: 'Subheading', bold: 'Bold (Ctrl+B)', italic: 'Italic (Ctrl+I)', underline: 'Underline (Ctrl+U)', strike: 'Strikethrough',
    bullet: 'Bulleted list', ordered: 'Numbered list', quote: 'Quote', link: 'Link', hr: 'Divider', undo: 'Undo (Ctrl+Z)', redo: 'Redo (Ctrl+Shift+Z)',
    clear: 'Clear formatting', source: 'HTML source', visual: 'Back to editor', linkPh: 'https://…', linkOk: 'OK', linkRemove: 'Remove link',
    tip: 'Enter starts a new paragraph, Shift+Enter a line break; you can paste from Word or Lark.',
  },
};
const isEmptyDoc = (html) => !html || html === '<p></p>';

export default function RichText({ value, onChange, placeholder, readOnly = false, minHeight = 260 }) {
  const { lang } = useI18n();
  const s = T[lang];
  const [source, setSource] = useState(false);
  const [srcText, setSrcText] = useState('');
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkVal, setLinkVal] = useState('');
  const lastEmitted = useRef(value || '');
  const [, force] = useState(0); // 选区变化时刷新工具栏的「已选中」状态
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [2, 3] },
        codeBlock: false,
        link: { openOnClick: false, autolink: true, protocols: ['http', 'https', 'mailto'], HTMLAttributes: { rel: 'noopener', target: '_blank' } },
      }),
      Placeholder.configure({ placeholder: placeholder || '' }),
    ],
    content: value || '',
    editable: !readOnly,
    immediatelyRender: true,
    onUpdate: ({ editor: ed }) => {
      const html = ed.getHTML();
      const out = isEmptyDoc(html) ? '' : html;
      lastEmitted.current = out;
      if (onChange) onChange(out);
    },
    onSelectionUpdate: () => force((n) => n + 1),
    onTransaction: () => force((n) => n + 1),
  });
  // 外部改写 value（AI 翻译、切换小节）时同步进编辑器；自己刚发出去的值不回写，避免光标跳动
  useEffect(() => {
    if (!editor) return;
    const v = value || '';
    if (v === lastEmitted.current) return;
    lastEmitted.current = v;
    editor.commands.setContent(v, { emitUpdate: false });
  }, [value, editor]);
  // CX-070（10/11 上线前测试）：setEditable 默认会发一次 update，编辑器把规整后的 HTML 回传，没改动的小节也显示「有未保存的修改」
  useEffect(() => { if (editor) editor.setEditable(!readOnly, false); }, [readOnly, editor]);
  if (!editor) return null;

  const btn = (key, label, run, active, extra) => (
    <button key={key} type="button" className={'rt-btn' + (active ? ' on' : '') + (extra ? ' ' + extra : '')}
      title={s[key] || label} aria-label={s[key] || label} aria-pressed={!!active} disabled={readOnly || source}
      onMouseDown={(e) => e.preventDefault()} onClick={run}>{label}</button>
  );
  const ch = () => editor.chain().focus();
  const openSource = () => { setSrcText(editor.getHTML()); setSource(true); };
  const closeSource = () => {
    editor.commands.setContent(srcText || '', { emitUpdate: true });
    setSource(false);
  };
  const applyLink = () => {
    const url = linkVal.trim();
    if (!url) ch().extendMarkRange('link').unsetLink().run();
    else ch().extendMarkRange('link').setLink({ href: /^(https?:|mailto:|\/)/i.test(url) ? url : 'https://' + url }).run();
    setLinkOpen(false);
  };
  return (
    <div className={'rt' + (readOnly ? ' rt-ro' : '')}>
      {!readOnly && (
        <div className="rt-bar" role="toolbar">
          {btn('para', s.para, () => ch().setParagraph().run(), editor.isActive('paragraph'), 'rt-txt')}
          {btn('h2', 'H2', () => ch().toggleHeading({ level: 2 }).run(), editor.isActive('heading', { level: 2 }))}
          {btn('h3', 'H3', () => ch().toggleHeading({ level: 3 }).run(), editor.isActive('heading', { level: 3 }))}
          <span className="rt-sep" />
          {btn('bold', <b>B</b>, () => ch().toggleBold().run(), editor.isActive('bold'))}
          {btn('italic', <i>I</i>, () => ch().toggleItalic().run(), editor.isActive('italic'))}
          {btn('underline', <u>U</u>, () => ch().toggleUnderline().run(), editor.isActive('underline'))}
          {btn('strike', <s>S</s>, () => ch().toggleStrike().run(), editor.isActive('strike'))}
          <span className="rt-sep" />
          {btn('bullet', '•≡', () => ch().toggleBulletList().run(), editor.isActive('bulletList'))}
          {btn('ordered', '1≡', () => ch().toggleOrderedList().run(), editor.isActive('orderedList'))}
          {btn('quote', '❝', () => ch().toggleBlockquote().run(), editor.isActive('blockquote'))}
          <Popover visible={linkOpen} trigger="custom" position="bottom" onClickOutSide={() => setLinkOpen(false)}
            content={(
              <div className="rt-linkpop">
                <Input size="small" autoFocus value={linkVal} onChange={setLinkVal} placeholder={s.linkPh} onEnterPress={applyLink} />
                <Button size="small" theme="solid" onClick={applyLink}>{s.linkOk}</Button>
                {editor.isActive('link') && <Button size="small" type="danger" theme="borderless" onClick={() => { ch().extendMarkRange('link').unsetLink().run(); setLinkOpen(false); }}>{s.linkRemove}</Button>}
              </div>
            )}>
            {btn('link', <IcLink />, () => { setLinkVal(editor.getAttributes('link').href || ''); setLinkOpen(true); }, editor.isActive('link'))}
          </Popover>
          {btn('hr', '―', () => ch().setHorizontalRule().run(), false)}
          <span className="rt-sep" />
          {btn('clear', 'Tx', () => ch().unsetAllMarks().clearNodes().run(), false)}
          {btn('undo', '↶', () => ch().undo().run(), false)}
          {btn('redo', '↷', () => ch().redo().run(), false)}
          <span className="rt-grow" />
          <button type="button" className={'rt-btn rt-txt' + (source ? ' on' : '')} onClick={source ? closeSource : openSource}>{source ? s.visual : s.source}</button>
        </div>
      )}
      {source ? (
        <textarea className="rt-src" style={{ minHeight }} value={srcText} onChange={(e) => setSrcText(e.target.value)} spellCheck={false} />
      ) : (
        <EditorContent editor={editor} className="rt-content prose" style={{ '--rt-min': minHeight + 'px' }} />
      )}
      {!readOnly && <div className="rt-tip">{s.tip}</div>}
    </div>
  );
}
