var w = Object.defineProperty;
var v = (t, e, n) => e in t ? w(t, e, {
    enumerable: !0,
    configurable: !0,
    writable: !0,
    value: n
}) : t[e] = n;
var c = (t, e, n) => v(t, typeof e != "symbol" ? e + "" : e, n);
(function() {
    const e = document.createElement("link").relList;
    if (e && e.supports && e.supports("modulepreload")) return;
    for (const i of document.querySelectorAll('link[rel="modulepreload"]')) r(i);
    new MutationObserver(i => {
        for (const s of i)
            if (s.type === "childList")
                for (const o of s.addedNodes) o.tagName === "LINK" && o.rel === "modulepreload" && r(o)
    }).observe(document, {
        childList: !0,
        subtree: !0
    });

    function n(i) {
        const s = {};
        return i.integrity && (s.integrity = i.integrity), i.referrerPolicy && (s.referrerPolicy = i.referrerPolicy), i.crossOrigin === "use-credentials" ? s.credentials = "include" : i.crossOrigin === "anonymous" ? s.credentials = "omit" : s.credentials = "same-origin", s
    }

    function r(i) {
        if (i.ep) return;
        i.ep = !0;
        const s = n(i);
        fetch(i.href, s)
    }
})();

function A(t) {
    try {
        return localStorage.getItem(t)
    } catch {
        return null
    }
}

function g(t, e, n) {
    const r = () => {
        const i = e(),
            s = A(t);
        if (!s) return i;
        try {
            const o = JSON.parse(s);
            return E(o) ? (n(i, o), i) : e()
        } catch {
            return e()
        }
    };
    return {
        key: t,
        defaults: e,
        load: r,
        loadInto(i) {
            return Object.assign(i, r())
        },
        save(i) {
            try {
                localStorage.setItem(t, JSON.stringify(i))
            } catch {}
        },
        clear() {
            try {
                localStorage.removeItem(t)
            } catch {}
        }
    }
}

function E(t) {
    return typeof t == "object" && t !== null && !Array.isArray(t)
}

function N(t, e) {
    return typeof t == "boolean" ? t : e
}

function L(t, e, n = {}) {
    if (typeof t != "number" || !Number.isFinite(t)) return e;
    let r = t;
    return n.integer && (r = Math.round(r)), n.min !== void 0 && (r = Math.max(n.min, r)), n.max !== void 0 && (r = Math.min(n.max, r)), r
}

function C(t, e, n) {
    return typeof t == "string" && e.includes(t) ? t : n
}

function I(t, e, n) {
    return Array.isArray(t) ? t.filter(e).slice(0, n) : null
}
const m = g("car-soccer.controller.v1", () => ({
    id: null,
    index: null
}), (t, e) => {
    typeof e.id == "string" && e.id.length > 0 && (t.id = e.id), typeof e.index == "number" && Number.isFinite(e.index) && e.index >= 0 && (t.index = L(e.index, 0, {
        min: 0,
        integer: !0
    }))
});
let d;
const u = new Set;

function x() {
    var t;
    try {
        return typeof navigator > "u" ? [] : ((t = navigator.getGamepads) == null ? void 0 : t.call(navigator)) ?? []
    } catch {
        return []
    }
}

function b() {
    return d ?? (d = m.load()), {
        ...d
    }
}

function M(t) {
    const e = b(),
        n = t ? {
            id: t.id,
            index: t.index
        } : {
            id: null,
            index: null
        };
    if (!(e.id === n.id && e.index === n.index)) {
        if (d = n, u.clear(), t)
            for (const r of x()) r != null && r.connected && r.id === t.id && r.index !== t.index && u.add(r.index);
        m.save(n), typeof window < "u" && window.dispatchEvent(new Event("controllerselectionchanged"))
    }
}

function O() {
    const t = b(),
        e = x().filter(o => !!(o != null && o.connected));
    if (t.id === null) return e.find(o => o.mapping === "standard") ?? e[0] ?? null;
    const n = e.filter(o => o.id === t.id),
        r = n.find(o => o.index === t.index);
    if (r) {
        for (const o of n) o.index !== r.index && u.add(o.index);
        return r
    }
    const i = n.filter(o => !u.has(o.index));
    if (i.length !== 1) return null;
    const s = i[0];
    return d = {
        id: s.id,
        index: s.index
    }, m.save(d), s
}
class P {
    constructor(e, n) {
        c(this, "frame", 0);
        c(this, "previous", []);
        c(this, "direction", 0);
        c(this, "repeatAt", 0);
        c(this, "padKey", "");
        c(this, "waitForNeutral", !0);
        c(this, "root");
        c(this, "close");
        c(this, "key", e => {
            e.stopImmediatePropagation(), this.root.classList.remove("sponsor-pad"), e.code === "Escape" && (e.preventDefault(), e.repeat || this.close()), e.code === "Tab" && (e.preventDefault(), this.move(e.shiftKey ? -1 : 1))
        });
        c(this, "poll", e => {
            var y;
            this.frame = requestAnimationFrame(this.poll);
            const n = O(),
                r = n ? `${n.id}:${n.index}` : "";
            if (r !== this.padKey && (this.padKey = r, this.previous = (n == null ? void 0 : n.buttons.map(h => h.pressed)) ?? [], this.waitForNeutral = !0), !n) return;
            const i = n.buttons.map(h => h.pressed),
                s = i[0] && !this.previous[0],
                o = i[1] && !this.previous[1];
            if (this.previous = i, o) {
                this.close();
                return
            }
            s && (this.root.classList.add("sponsor-pad"), (y = document.activeElement) == null || y.click());
            const f = (i[13] ? 1 : 0) - (i[12] ? 1 : 0) || (Math.abs(n.axes[1] ?? 0) > .55 ? Math.sign(n.axes[1]) : 0),
                p = (i[15] ? 1 : 0) - (i[14] ? 1 : 0) || (Math.abs(n.axes[0] ?? 0) > .55 ? Math.sign(n.axes[0]) : 0);
            if (this.waitForNeutral) {
                if (p || f) return;
                this.waitForNeutral = !1
            }
            const l = f || p;
            if (!l) {
                this.direction = 0;
                return
            }
            if (l !== this.direction) this.direction = l, this.repeatAt = e + 380;
            else {
                if (e < this.repeatAt) return;
                this.repeatAt = e + 110
            }
            this.root.classList.add("sponsor-pad");
            const a = document.activeElement;
            !f && a instanceof HTMLInputElement && a.type === "number" ? (p > 0 ? a.stepUp() : a.stepDown(), a.dispatchEvent(new Event("input", {
                bubbles: !0
            }))) : this.move(l)
        });
        this.root = e, this.close = n
    }
    controls() {
        return [...this.root.querySelectorAll("button, input:not([type=file]), textarea, select, summary, a[href]")].filter(e => !e.closest("[hidden], [inert]") && !e.disabled && e.getClientRects().length > 0)
    }
    move(e) {
        var i;
        const n = this.controls(),
            r = n.indexOf(document.activeElement);
        (i = n[(r + e + n.length) % n.length]) == null || i.focus()
    }
    start() {
        this.stop(), this.previous = [], this.padKey = "", this.waitForNeutral = !0, window.addEventListener("keydown", this.key, !0), this.frame = requestAnimationFrame(this.poll)
    }
    stop() {
        cancelAnimationFrame(this.frame), window.removeEventListener("keydown", this.key, !0), this.root.classList.remove("sponsor-pad")
    }
}
const S = g("car-soccer.analytics-consent.v1", () => ({
        enabled: !0
    }), (t, e) => {
        t.enabled = N(e.enabled, !1)
    }),
    R = () => S.load().enabled && navigator.doNotTrack !== "1" && !navigator.globalPrivacyControl;
export {
    S as A, P as S, I as a, N as b, C as c, g as d, x as e, b as f, O as g, R as h, E as i, L as r, M as s
};