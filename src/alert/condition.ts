/**
 * 条件表达式系统
 * 可组合的 AST 表达式，用于告警规则过滤事件
 */

/** 条件表达式 AST 节点 */
export type ConditionExpr =
  | { op: "and"; children: ConditionExpr[] }
  | { op: "or"; children: ConditionExpr[] }
  | { op: "not"; child: ConditionExpr }
  | { op: "contains"; field: string; value: string }
  | { op: "equals"; field: string; value: string }
  | { op: "notEquals"; field: string; value: string }
  | { op: "greaterThan"; field: string; value: number }
  | { op: "lessThan"; field: string; value: number }
  | { op: "matches"; field: string; pattern: string }
  | { op: "exists"; field: string };

/** 按字段路径从对象中安全取值 */
function getField(payload: Record<string, unknown>, field: string): unknown {
  const parts = field.split(".");
  let current: unknown = payload;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current === "object") {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
}

/** RegExp 编译缓存（pattern → compiled） */
const regexCache = new Map<string, RegExp | null>();

/** 递归求值条件表达式 */
export function evaluate(expr: ConditionExpr, payload: Record<string, unknown>): boolean {
  switch (expr.op) {
    case "and":
      return expr.children.every(c => evaluate(c, payload));
    case "or":
      return expr.children.some(c => evaluate(c, payload));
    case "not":
      return !evaluate(expr.child, payload);
    case "contains": {
      const val = getField(payload, expr.field);
      return typeof val === "string" && val.includes(expr.value);
    }
    case "equals": {
      const val = getField(payload, expr.field);
      return String(val) === expr.value;
    }
    case "notEquals": {
      const val = getField(payload, expr.field);
      return String(val) !== expr.value;
    }
    case "greaterThan": {
      const val = Number(getField(payload, expr.field));
      return !isNaN(val) && val > expr.value;
    }
    case "lessThan": {
      const val = Number(getField(payload, expr.field));
      return !isNaN(val) && val < expr.value;
    }
    case "matches": {
      const val = String(getField(payload, expr.field) ?? "");
      let re = regexCache.get(expr.pattern);
      if (re === undefined) {
        try {
          re = new RegExp(expr.pattern);
        } catch {
          re = null;
        }
        regexCache.set(expr.pattern, re);
      }
      return re ? re.test(val) : false;
    }
    case "exists": {
      return getField(payload, expr.field) !== undefined;
    }
  }
}

/** 合法操作符白名单 */
const VALID_OPS = new Set(["and", "or", "not", "contains", "equals", "notEquals", "greaterThan", "lessThan", "matches", "exists"]);

/**
 * 解析条件 JSON
 * 支持新格式（AST）和旧格式（resultContains/valueEquals/valueNotEquals）自动转换
 */
export function parseCondition(json: string): ConditionExpr | null {
  if (!json) return null;
  try {
    const obj = JSON.parse(json) as Record<string, unknown>;
    if (!obj || typeof obj !== "object") return null;

    /** 新格式：有 op 字段 */
    if (obj.op) {
      if (!VALID_OPS.has(obj.op as string)) {
        console.warn(`[Condition] 未知操作符: ${obj.op}`);
        return null;
      }
      return obj as unknown as ConditionExpr;
    }

    /** 旧格式兼容转换 */
    const children: ConditionExpr[] = [];

    if (typeof obj.resultContains === "string" && obj.resultContains) {
      children.push({ op: "contains", field: "result", value: obj.resultContains });
    }
    if (typeof obj.valueEquals === "string" && obj.valueEquals) {
      children.push({ op: "equals", field: "newValue", value: obj.valueEquals });
    }
    if (typeof obj.valueNotEquals === "string" && obj.valueNotEquals) {
      children.push({ op: "notEquals", field: "newValue", value: obj.valueNotEquals });
    }

    if (children.length === 0) return null;
    if (children.length === 1) return children[0]!;
    return { op: "and", children };
  } catch {
    return null;
  }
}
