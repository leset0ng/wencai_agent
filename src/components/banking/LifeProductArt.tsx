import { useId } from 'react'
import type { LifeProduct } from '#/lib/life-market'

/** Local vector placeholders: no external image requests or third-party product branding. */
export function LifeProductArt({product}:{product:LifeProduct}) {
  const id=useId().replaceAll(':','')
  const fill=(name:string)=>`url(#${id}-${name})`
  return <svg className="bank-life-art" viewBox="0 0 320 250" role="img" aria-label={`${product.name}演示插画`}>
    <defs>
      <radialGradient id={`${id}-bg`}><stop stopColor="#4b427e"/><stop offset="1" stopColor="#171b31"/></radialGradient>
      <linearGradient id={`${id}-purple`} x2=".8" y2="1"><stop stopColor="#aaa9ff"/><stop offset=".45" stopColor="#6864f4"/><stop offset="1" stopColor="#302e76"/></linearGradient>
      <linearGradient id={`${id}-white`}><stop stopColor="#bfc1d7"/><stop offset=".36" stopColor="#f1f0fb"/><stop offset="1" stopColor="#a3a5bc"/></linearGradient>
      <linearGradient id={`${id}-navy`} x2="1" y2=".8"><stop stopColor="#707aab"/><stop offset=".45" stopColor="#373f6e"/><stop offset="1" stopColor="#171c3a"/></linearGradient>
      <linearGradient id={`${id}-rose`}><stop stopColor="#dfc2bb"/><stop offset=".5" stopColor="#f2dad0"/><stop offset="1" stopColor="#b58c95"/></linearGradient>
      <filter id={`${id}-shadow`} x="-50%" y="-50%" width="200%" height="220%"><feDropShadow dx="0" dy="15" stdDeviation="10" floodColor="#080915" floodOpacity=".65"/></filter>
    </defs>
    <rect width="320" height="250" fill={fill('bg')}/>
    <path d="M0 207Q75 156 150 200T320 183V250H0Z" fill="#ffffff04"/><path d="M0 158Q95 115 169 159T320 145" fill="none" stroke="#9c91ff12" strokeWidth="2"/>
    <ellipse cx="165" cy="217" rx="103" ry="17" fill="#08091455"/>
    <g filter={fill('shadow')}>
      {product.art==='cup' && <><rect x="121" y="45" width="79" height="166" rx="16" fill={fill('white')}/><rect x="120" y="39" width="81" height="24" rx="11" fill={fill('white')} stroke="#777c93"/><path d="M122 68H199" stroke="#393c54" strokeWidth="5"/><path d="M135 81V185" stroke="#ffffff80" strokeWidth="3"/><ellipse cx="160" cy="42" rx="35" ry="6" fill="#e5e5f2"/></>}
      {product.art==='umbrella' && <g transform="rotate(27 160 125)"><rect x="134" y="40" width="56" height="155" rx="17" fill={fill('navy')} stroke="#9c9ec155"/><path d="M145 49L139 179M162 44V189M179 49L185 179" stroke="#b5bbdf33" strokeWidth="2"/><rect x="133" y="102" width="58" height="22" rx="4" fill="#252c50"/><rect x="145" y="27" width="35" height="19" rx="6" fill="#1e233e"/><path d="M180 31Q230 68 212 131" fill="none" stroke="#10152c" strokeWidth="8"/><rect x="145" y="192" width="35" height="15" rx="5" fill="#1a1f37"/></g>}
      {product.art==='organizer' && <><path d="M80 109L186 92L231 119L128 139Z" fill="#c9c9df"/><path d="M80 109L128 139V218L80 188Z" fill="#9295b1"/><path d="M128 139L231 119V197L128 218Z" fill={fill('white')}/><path d="M130 140V217M182 129V205" stroke="#747993" strokeWidth="2"/><rect x="106" y="65" width="49" height="72" rx="5" fill="#e1dfea" transform="rotate(-8 106 65)"/><path d="M110 91L150 86" stroke="#aaa9c1"/><rect x="184" y="75" width="7" height="63" rx="3" fill="#a8adce" transform="rotate(14 184 75)"/><rect x="203" y="64" width="7" height="72" rx="3" fill="#dedbea" transform="rotate(17 203 64)"/><path d="M91 151L147 142V181L91 189Z" fill={fill('rose')}/><path d="M90 168L150 158V205L90 216Z" fill={fill('white')}/></>}
      {product.art==='gift' && <g transform="rotate(-8 160 130)"><rect x="60" y="70" width="202" height="134" rx="12" fill={fill('purple')} stroke="#b9aeff"/><path d="M209 70V204" stroke={fill('rose')} strokeWidth="20"/><path d="M174 104Q160 66 205 106Q246 57 235 109L210 120Z" fill={fill('rose')} stroke="#bb929a"/><path d="M206 119L176 171L192 167L204 179L216 123" fill={fill('rose')}/><text x="80" y="145" fill="#efedff" fontSize="17" fontWeight="600">生活礼品卡</text><text x="81" y="167" fill="#d3ceff" fontSize="9" letterSpacing="2">GIFT CARD · DEMO</text></g>}
      {product.art==='video' && <g transform="rotate(7 160 130)"><rect x="67" y="61" width="199" height="146" rx="28" fill={fill('purple')} stroke="#c4bdff" strokeWidth="2"/><rect x="78" y="72" width="174" height="121" rx="21" fill={fill('navy')}/><path d="M141 101Q137 98 137 105V163Q137 169 143 165L187 139Q193 135 187 131Z" fill={fill('purple')} stroke="#b8aaff"/></g>}
      {product.art==='music' && <><path d="M82 153V127A78 78 0 0 1 238 127V153" fill="none" stroke="#22274a" strokeWidth="25"/><path d="M82 141V125A78 78 0 0 1 238 125V141" fill="none" stroke={fill('purple')} strokeWidth="15"/><rect x="66" y="126" width="48" height="79" rx="24" fill={fill('purple')}/><rect x="75" y="136" width="26" height="59" rx="13" fill="#212846"/><rect x="209" y="126" width="48" height="79" rx="24" fill={fill('purple')}/><rect x="220" y="136" width="26" height="59" rx="13" fill="#212846"/></>}
      {product.art==='cloud' && <><path d="M83 192C27 184 41 113 91 119C93 53 184 42 204 106C261 88 290 182 233 194Z" fill={fill('purple')} stroke="#a8baff" strokeWidth="2"/><path d="M145 187V147H119L159 106L199 147H176V187Z" fill={fill('white')} stroke="#d4ddff"/></>}
      {product.art==='book' && <g transform="rotate(8 160 130)"><path d="M57 78Q113 63 162 91Q209 66 264 80V202Q210 188 162 211Q109 192 57 202Z" fill={fill('purple')}/><path d="M65 69Q114 57 162 85Q210 60 257 72V191Q209 178 162 201Q112 179 65 191Z" fill={fill('white')}/><path d="M162 85V201" stroke="#8d8dc1" strokeWidth="3"/>{[0,1,2,3,4,5].map(i=><g key={i} stroke="#a4a4cf" strokeWidth="4"><path d={`M80 ${89+i*14}Q117 ${82+i*14} 145 ${100+i*14}`}/><path d={`M180 ${101+i*14}Q213 ${84+i*14} 244 ${89+i*14}`}/></g>)}</g>}
    </g>
  </svg>
}
