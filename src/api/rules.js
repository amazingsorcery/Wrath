'use strict';

/**
 * Small expression language for highlight rules, e.g. `fkdr > 5 && star >= 300`.
 * Hand written parser instead of eval since rules come from user input.
 *
 * Supports: + - * / % ( ) < <= > >= = == != && || ! and numbers.
 */

const TOKEN = /\s*(\d+\.?\d*|[A-Za-z_][A-Za-z0-9_]*|<=|>=|==|!=|&&|\|\||[-+*/%()<>=!])/y;

class RuleError extends Error {
    constructor(message) {
        super(message);
        this.name = 'RuleError';
    }
}

function tokenize(source) {
    const tokens = [];
    TOKEN.lastIndex = 0;
    let index = 0;
    while (index < source.length) {
        TOKEN.lastIndex = index;
        const match = TOKEN.exec(source);
        if (!match) {
            const rest = source.slice(index).trim();
            if (!rest) break;
            throw new RuleError(`Unexpected character at "${rest.slice(0, 12)}"`);
        }
        tokens.push(match[1]);
        index = TOKEN.lastIndex;
    }
    return tokens;
}

/** Parse an expression into a tree. Throws RuleError on bad input. */
function parse(source) {
    const tokens = tokenize(String(source));
    let position = 0;

    const peek = () => tokens[position];
    const take = () => tokens[position++];
    const expect = (token) => {
        if (peek() !== token) throw new RuleError(`Expected "${token}" but found ${peek() ? `"${peek()}"` : 'end of rule'}`);
        return take();
    };

    // or := and ( "||" and )*
    function parseOr() {
        let left = parseAnd();
        while (peek() === '||') {
            take();
            left = { kind: 'or', left, right: parseAnd() };
        }
        return left;
    }

    function parseAnd() {
        let left = parseComparison();
        while (peek() === '&&') {
            take();
            left = { kind: 'and', left, right: parseComparison() };
        }
        return left;
    }

    function parseComparison() {
        let left = parseAdditive();
        while (['<', '<=', '>', '>=', '=', '==', '!='].includes(peek())) {
            const op = take();
            left = { kind: 'compare', op: op === '==' ? '=' : op, left, right: parseAdditive() };
        }
        return left;
    }

    function parseAdditive() {
        let left = parseMultiplicative();
        while (peek() === '+' || peek() === '-') {
            const op = take();
            left = { kind: 'binary', op, left, right: parseMultiplicative() };
        }
        return left;
    }

    function parseMultiplicative() {
        let left = parseUnary();
        while (peek() === '*' || peek() === '/' || peek() === '%') {
            const op = take();
            left = { kind: 'binary', op, left, right: parseUnary() };
        }
        return left;
    }

    function parseUnary() {
        if (peek() === '-') {
            take();
            return { kind: 'negate', value: parseUnary() };
        }
        if (peek() === '!') {
            take();
            return { kind: 'not', value: parseUnary() };
        }
        return parsePrimary();
    }

    function parsePrimary() {
        const token = take();
        if (token === undefined) throw new RuleError('Rule ended unexpectedly');
        if (token === '(') {
            const inner = parseOr();
            expect(')');
            return inner;
        }
        if (/^\d/.test(token)) return { kind: 'number', value: Number.parseFloat(token) };
        if (/^[A-Za-z_]/.test(token)) return { kind: 'variable', name: token.toLowerCase() };
        throw new RuleError(`Unexpected "${token}"`);
    }

    const tree = parseOr();
    if (position < tokens.length) throw new RuleError(`Unexpected "${tokens[position]}" at the end of the rule`);
    return tree;
}

function evaluate(node, vars) {
    switch (node.kind) {
        case 'number':
            return node.value;
        case 'variable': {
            const value = vars[node.name];
            if (value === undefined || value === null) return 0;
            return typeof value === 'boolean' ? (value ? 1 : 0) : Number(value) || 0;
        }
        case 'negate':
            return -evaluate(node.value, vars);
        case 'not':
            return truthy(evaluate(node.value, vars)) ? 0 : 1;
        case 'binary': {
            const left = evaluate(node.left, vars);
            const right = evaluate(node.right, vars);
            switch (node.op) {
                case '+': return left + right;
                case '-': return left - right;
                case '*': return left * right;
                case '/': return right === 0 ? 0 : left / right;
                case '%': return right === 0 ? 0 : left % right;
                default: throw new RuleError(`Unknown operator ${node.op}`);
            }
        }
        case 'compare': {
            const left = evaluate(node.left, vars);
            const right = evaluate(node.right, vars);
            switch (node.op) {
                case '<': return left < right ? 1 : 0;
                case '<=': return left <= right ? 1 : 0;
                case '>': return left > right ? 1 : 0;
                case '>=': return left >= right ? 1 : 0;
                case '=': return left === right ? 1 : 0;
                case '!=': return left !== right ? 1 : 0;
                default: throw new RuleError(`Unknown comparison ${node.op}`);
            }
        }
        case 'and':
            return truthy(evaluate(node.left, vars)) && truthy(evaluate(node.right, vars)) ? 1 : 0;
        case 'or':
            return truthy(evaluate(node.left, vars)) || truthy(evaluate(node.right, vars)) ? 1 : 0;
        default:
            throw new RuleError(`Unknown node ${node.kind}`);
    }
}

const truthy = (value) => Number(value) !== 0;

/** Parse once, then test many players cheaply. */
function compile(source) {
    const tree = parse(source);
    return (vars) => truthy(evaluate(tree, vars));
}

/** The variables a rule can reference, pulled out of a stats object. */
function variablesFor(stats, extra = {}) {
    if (!stats) return { ...extra };
    const bw = stats.bedwars || {};
    const sw = stats.skywars || {};
    return {
        star: bw.star || 0,
        level: stats.networkLevel || 0,
        fkdr: bw.fkdr || 0,
        finals: bw.finalKills || 0,
        fdeaths: bw.finalDeaths || 0,
        wins: bw.wins || 0,
        losses: bw.losses || 0,
        wlr: bw.wlr || 0,
        ws: bw.winstreak || 0,
        // bedwars index
        index: (bw.star || 0) * (bw.fkdr || 0) * (bw.fkdr || 0),
        swlevel: Number.parseFloat(String(sw.level || '0')) || 0,
        swkdr: sw.kdr || 0,
        swwins: sw.wins || 0,
        duelswlr: (stats.duels && stats.duels.wlr) || 0,
        ...extra
    };
}

const VARIABLE_NAMES = [
    'star', 'level', 'fkdr', 'finals', 'fdeaths', 'wins', 'losses', 'wlr', 'ws',
    'index', 'swlevel', 'swkdr', 'swwins', 'duelswlr', 'tagged'
];

module.exports = { parse, evaluate, compile, variablesFor, tokenize, RuleError, VARIABLE_NAMES };
