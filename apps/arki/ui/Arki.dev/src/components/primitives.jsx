// Primitives: Button, Pill, CodeBlock, Card, Kbd

function Button({ variant = "primary", icon, children, ...rest }) {
  return (
    <button className={"btn " + variant} {...rest}>
      {icon && <i className={"ph ph-" + icon}></i>}
      {children}
    </button>
  );
}

function Pill({ status = "success", children }) {
  return (
    <span className={"pill " + status}>
      <span className="dot"></span>{children}
    </span>
  );
}

function Kbd({ children }) {
  return <span className="kbd" style={{
    fontFamily: "var(--font-mono)", fontSize: 11,
    border: "1px solid var(--border)", borderRadius: 3, padding: "1px 6px",
    color: "var(--muted-foreground)"
  }}>{children}</span>;
}

function CodeBlock({ lang = "typescript", filename, provenance, code, copyValue }) {
  const [copied, setCopied] = React.useState(false);
  const doCopy = () => {
    const text = copyValue || (typeof code === "string" ? code : "");
    try { navigator.clipboard.writeText(text); } catch (e) {}
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };
  return (
    <div className="code-block">
      <div className="head">
        <span>{filename || lang}</span>
        <button className={"copy" + (copied ? " ok" : "")} onClick={doCopy}>
          {copied ? "copied" : "Copy"}
        </button>
      </div>
      <pre>{code}</pre>
      {provenance && (
        <div className="provenance">
          <span>{provenance.label}</span>
          <a href="#">view ↗</a>
        </div>
      )}
    </div>
  );
}

// Convenience: a tagged DSL for tiny inline syntax highlighting.
// Used inline in JSX where we want hand-tinted token color.
const Tk = {
  kw:  (s) => <span className="tk-kw">{s}</span>,
  fn:  (s) => <span className="tk-fn">{s}</span>,
  str: (s) => <span className="tk-str">{s}</span>,
  v:   (s) => <span className="tk-var">{s}</span>,
  com: (s) => <span className="tk-com">{s}</span>,
  n:   (s) => <span className="tk-num">{s}</span>,
  p:   (s) => <span className="tk-pun">{s}</span>,
  b:   (s) => <span className="tk-bool">{s}</span>,
};

Object.assign(window, { Button, Pill, Kbd, CodeBlock, Tk });
