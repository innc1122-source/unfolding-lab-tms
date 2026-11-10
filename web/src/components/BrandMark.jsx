// 品牌区的 logo（10/11 负责人定：深底版、浅底版都要用上）。不引 Semi，员工端可用。
//   深底版 brand.logo：给深色背景画的（浅色字）。浅底版 brand.logoLight：给白色背景画的（深色字），可不传。
// 各处背景（Layout v2）：
//   · 桌面左侧栏顶部、登录页左侧大图：深底 → 用深底版；没有深底版时显示文字品牌名（浅底版放在深底上看不见）。
//   · 手机顶栏（≤900px）、重置密码页卡片：白底。上传了浅底版、且没有在品牌颜色里指定药丸底色（brandChipOnLight）时，
//     去掉深色药丸底，直接把浅底版放在白底上；否则仍是深色药丸底 + 深底版。
// surface：'dark' 只用深底版；'light' 白底场合；'adaptive' 顶栏 —— 桌面是深底、手机是白底，两张都渲染，由 v2.css 按宽度切换。
import { brandLogo, brandLogoLight, brandChipOnLight, brandWordmark } from '../brand.js';

// 品牌区容器要加的类：白底场合用浅底版时去掉药丸底
export function brandMarkClass(brand, surface) {
  if (!brandChipOnLight(brand)) return '';
  return surface === 'light' ? 'on-light' : surface === 'adaptive' ? 'brand-lt' : '';
}

export default function BrandMark({ brand, lang, surface = 'dark', style }) {
  const name = brandWordmark(brand, lang);
  const dark = brandLogo(brand);
  const light = brandChipOnLight(brand) ? brandLogoLight(brand) : '';
  // 顶栏在手机上要换成白底版本时（有浅底版，或品牌底透明），深底那张带 logo-dark，由 v2.css 在 ≤900px 隐藏
  const swap = surface === 'adaptive' && (!!light || brandChipOnLight(brand));
  const darkMark = dark
    ? <img className={'logo' + (swap ? ' logo-dark' : '')} src={dark} alt={name} style={style} />
    : <span className={'brand-wordmark' + (swap ? ' logo-dark' : '')}>{name}</span>;
  if (surface === 'light' && light) return <img className="logo" src={light} alt={name} style={style} />;
  if (surface === 'adaptive' && light) return <>{darkMark}<img className="logo logo-light" src={light} alt={name} style={style} /></>;
  // CX-081：白底处（品牌底透明）却没有上传浅底版 —— 深底版放在白底上看不见，改为深色文字品牌名
  if (brandChipOnLight(brand) && !light) {
    if (surface === 'light') return <span className="brand-wordmark wm-ink">{name}</span>;
    if (surface === 'adaptive') return <>{darkMark}<span className="brand-wordmark wm-ink logo-light">{name}</span></>;
  }
  return darkMark;
}
