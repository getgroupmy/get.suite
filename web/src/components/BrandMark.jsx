// The company's mark: its logo when it has one, or its first letter.
export default function BrandMark({ name, logo, accent }) {
  return logo
    ? <img className="brand-logo" src={logo} alt="" />
    : <span className="brand-mark" style={accent ? { background: accent } : undefined}>{(name || 'W').slice(0, 1).toUpperCase()}</span>;
}
