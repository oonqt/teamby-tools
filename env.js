export const optional = (name, def = undefined) => {
    const v = process.env[name];
    return v == null || v === '' ? def : v;
}

export const optionalBool = (name, def) => {
    const v = process.env[name];
    if (v == null || v === '') return def;
    return v.toLowerCase() === 'true';
}

export const required = (name) => {
    const v = process.env[name];
    if (!v) throw new Error(`Missing required env var: ${name}`);
    return v;
}