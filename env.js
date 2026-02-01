export const optional = (name, def = undefined) => {
    const v = process.env[name];
    return v == null || v === '' ? String(def) : v;
}

export const required = (name) => {
    const v = process.env[name];
    if (!v) throw new Error(`Missing required env var: ${name}`);
    return v;
}