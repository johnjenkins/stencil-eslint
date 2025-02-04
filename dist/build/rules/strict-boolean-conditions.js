/**
 * @license
 * Copyright 2016 Palantir Technologies, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import * as ts from "typescript";
const OPTION_ALLOW_NULL_UNION = "allow-null-union";
const OPTION_ALLOW_UNDEFINED_UNION = "allow-undefined-union";
const OPTION_ALLOW_STRING = "allow-string";
const OPTION_ALLOW_ENUM = "allow-enum";
const OPTION_ALLOW_NUMBER = "allow-number";
const OPTION_ALLOW_MIX = "allow-mix";
const OPTION_ALLOW_BOOLEAN_OR_UNDEFINED = "allow-boolean-or-undefined";
const OPTION_ALLOW_ANY_RHS = "allow-any-rhs";
const rule = {
    meta: {
        docs: {
            description: `Restricts the types allowed in boolean expressions. By default only booleans are allowed.
      The following nodes are checked:
      * Arguments to the \`!\`, \`&&\`, and \`||\` operators
      * The condition in a conditional expression (\`cond ? x : y\`)
      * Conditions for \`if\`, \`for\`, \`while\`, and \`do-while\` statements.`,
            category: 'Possible Errors',
            recommended: true
        },
        schema: [{
                type: "array",
                items: {
                    type: "string",
                    enum: [
                        OPTION_ALLOW_NULL_UNION,
                        OPTION_ALLOW_UNDEFINED_UNION,
                        OPTION_ALLOW_STRING,
                        OPTION_ALLOW_ENUM,
                        OPTION_ALLOW_NUMBER,
                        OPTION_ALLOW_BOOLEAN_OR_UNDEFINED,
                        OPTION_ALLOW_ANY_RHS
                    ],
                },
                minLength: 0,
                maxLength: 5,
            }],
        type: 'problem'
    },
    create(context) {
        const parserServices = context.sourceCode.parserServices;
        const program = parserServices.program;
        const rawOptions = context.options[0] || ['allow-null-union', 'allow-undefined-union', 'allow-boolean-or-undefined'];
        const options = parseOptions(rawOptions, true);
        const checker = program.getTypeChecker();
        function walk(sourceFile) {
            ts.forEachChild(sourceFile, function cb(node) {
                switch (node.kind) {
                    case ts.SyntaxKind.PrefixUnaryExpression: {
                        const { operator, operand } = node;
                        if (operator === ts.SyntaxKind.ExclamationToken) {
                            checkExpression(operand, node);
                        }
                        break;
                    }
                    case ts.SyntaxKind.IfStatement:
                    case ts.SyntaxKind.WhileStatement:
                    case ts.SyntaxKind.DoStatement: {
                        const c = node;
                        // If it's a boolean binary expression, we'll check it when recursing.
                        checkExpression(c.expression, c);
                        break;
                    }
                    case ts.SyntaxKind.ConditionalExpression:
                        checkExpression(node.condition, node);
                        break;
                    case ts.SyntaxKind.ForStatement: {
                        const { condition } = node;
                        if (condition !== undefined) {
                            checkExpression(condition, node);
                        }
                    }
                }
                return ts.forEachChild(node, cb);
            });
            function checkExpression(node, location) {
                const type = checker.getTypeAtLocation(node);
                const failure = getTypeFailure(type, options);
                if (failure !== undefined) {
                    if (failure === 0 /* TypeFailure.AlwaysTruthy */ &&
                        !options.strictNullChecks &&
                        (options.allowNullUnion || options.allowUndefinedUnion)) {
                        // OK; It might be null/undefined.
                        return;
                    }
                    const originalNode = parserServices.tsNodeToESTreeNodeMap.get(node);
                    context.report({
                        node: originalNode,
                        message: showFailure(location, failure, isUnionType(type), options),
                    });
                }
            }
        }
        return {
            'Program': (node) => {
                const sourceFile = parserServices.esTreeNodeToTSNodeMap.get(node);
                walk(sourceFile);
            }
        };
    }
};
function parseOptions(ruleArguments, strictNullChecks) {
    return {
        strictNullChecks,
        allowNullUnion: has(OPTION_ALLOW_NULL_UNION),
        allowUndefinedUnion: has(OPTION_ALLOW_UNDEFINED_UNION),
        allowString: has(OPTION_ALLOW_STRING),
        allowEnum: has(OPTION_ALLOW_ENUM),
        allowNumber: has(OPTION_ALLOW_NUMBER),
        allowMix: has(OPTION_ALLOW_MIX),
        allowBooleanOrUndefined: has(OPTION_ALLOW_BOOLEAN_OR_UNDEFINED),
        allowAnyRhs: has(OPTION_ALLOW_ANY_RHS),
    };
    function has(name) {
        return ruleArguments.indexOf(name) !== -1;
    }
}
function getTypeFailure(type, options) {
    if (isUnionType(type)) {
        return handleUnion(type, options);
    }
    const kind = getKind(type);
    const failure = failureForKind(kind, /*isInUnion*/ false, options);
    if (failure !== undefined) {
        return failure;
    }
    switch (triState(kind)) {
        case true:
            // Allow 'any'. Allow 'true' itself, but not any other always-truthy type.
            // tslint:disable-next-line no-bitwise
            return isTypeFlagSet(type, ts.TypeFlags.Any | ts.TypeFlags.BooleanLiteral) ? undefined : 0 /* TypeFailure.AlwaysTruthy */;
        case false:
            // Allow 'false' itself, but not any other always-falsy type
            return isTypeFlagSet(type, ts.TypeFlags.BooleanLiteral) ? undefined : 1 /* TypeFailure.AlwaysFalsy */;
        case undefined:
            return undefined;
    }
}
function isBooleanUndefined(type) {
    let isTruthy = false;
    for (const ty of type.types) {
        if (isTypeFlagSet(ty, ts.TypeFlags.Boolean)) {
            isTruthy = true;
        }
        else if (isTypeFlagSet(ty, ts.TypeFlags.BooleanLiteral)) {
            isTruthy = isTruthy || ty.intrinsicName === "true";
        }
        else if (!isTypeFlagSet(ty, ts.TypeFlags.Void | ts.TypeFlags.Undefined)) { // tslint:disable-line:no-bitwise
            return undefined;
        }
    }
    return isTruthy;
}
function handleUnion(type, options) {
    if (options.allowBooleanOrUndefined) {
        switch (isBooleanUndefined(type)) {
            case true:
                return undefined;
            case false:
                return 1 /* TypeFailure.AlwaysFalsy */;
        }
    }
    for (const ty of type.types) {
        const kind = getKind(ty);
        const failure = failureForKind(kind, /*isInUnion*/ true, options);
        if (failure !== undefined) {
            return failure;
        }
    }
    return undefined;
}
/** Fails if a kind of falsiness is not allowed. */
function failureForKind(kind, isInUnion, options) {
    switch (kind) {
        case 0 /* TypeKind.String */:
        case 1 /* TypeKind.FalseStringLiteral */:
            return options.allowString ? undefined : 2 /* TypeFailure.String */;
        case 2 /* TypeKind.Number */:
        case 3 /* TypeKind.FalseNumberLiteral */:
            return options.allowNumber ? undefined : 3 /* TypeFailure.Number */;
        case 8 /* TypeKind.Enum */:
            return options.allowEnum ? undefined : 6 /* TypeFailure.Enum */;
        case 10 /* TypeKind.Promise */:
            return 8 /* TypeFailure.Promise */;
        case 6 /* TypeKind.Null */:
            return isInUnion && !options.allowNullUnion ? 4 /* TypeFailure.Null */ : undefined;
        case 7 /* TypeKind.Undefined */:
            return isInUnion && !options.allowUndefinedUnion ? 5 /* TypeFailure.Undefined */ : undefined;
        default:
            return undefined;
    }
}
/** Divides a type into always true, always false, or unknown. */
function triState(kind) {
    switch (kind) {
        case 0 /* TypeKind.String */:
        case 2 /* TypeKind.Number */:
        case 4 /* TypeKind.Boolean */:
        case 8 /* TypeKind.Enum */:
            return undefined;
        case 6 /* TypeKind.Null */:
        case 7 /* TypeKind.Undefined */:
        case 3 /* TypeKind.FalseNumberLiteral */:
        case 1 /* TypeKind.FalseStringLiteral */:
        case 5 /* TypeKind.FalseBooleanLiteral */:
            return false;
        case 9 /* TypeKind.AlwaysTruthy */:
        case 10 /* TypeKind.Promise */:
            return true;
    }
}
function getKind(type) {
    return is(ts.TypeFlags.StringLike) ? 0 /* TypeKind.String */ :
        is(ts.TypeFlags.NumberLike) ? 2 /* TypeKind.Number */ :
            is(ts.TypeFlags.Boolean) ? 4 /* TypeKind.Boolean */ :
                isObject('Promise') ? 10 /* TypeKind.Promise */ :
                    is(ts.TypeFlags.Null) ? 6 /* TypeKind.Null */ :
                        is(ts.TypeFlags.Undefined | ts.TypeFlags.Void) ? 7 /* TypeKind.Undefined */
                            :
                                is(ts.TypeFlags.EnumLike) ? 8 /* TypeKind.Enum */ :
                                    is(ts.TypeFlags.BooleanLiteral) ?
                                        (type.intrinsicName === "true" ? 9 /* TypeKind.AlwaysTruthy */ : 5 /* TypeKind.FalseBooleanLiteral */) :
                                        9 /* TypeKind.AlwaysTruthy */;
    function is(flags) {
        return isTypeFlagSet(type, flags);
    }
    function isObject(name) {
        const symbol = type.getSymbol();
        return (symbol && symbol.getName() === name);
    }
}
function binaryBooleanExpressionKind(node) {
    switch (node.operatorToken.kind) {
        case ts.SyntaxKind.AmpersandAmpersandToken:
            return "&&";
        case ts.SyntaxKind.BarBarToken:
            return "||";
        default:
            return undefined;
    }
}
function stringOr(parts) {
    switch (parts.length) {
        case 1:
            return parts[0];
        case 2:
            return `${parts[0]} or ${parts[1]}`;
        default:
            let res = "";
            for (let i = 0; i < parts.length - 1; i++) {
                res += `${parts[i]}, `;
            }
            return `${res}or ${parts[parts.length - 1]}`;
    }
}
function isUnionType(type) {
    return isTypeFlagSet(type, ts.TypeFlags.Union) && !isTypeFlagSet(type, ts.TypeFlags.Enum);
}
function showLocation(n) {
    switch (n.kind) {
        case ts.SyntaxKind.PrefixUnaryExpression:
            return "operand for the '!' operator";
        case ts.SyntaxKind.ConditionalExpression:
            return "condition";
        case ts.SyntaxKind.ForStatement:
            return "'for' condition";
        case ts.SyntaxKind.IfStatement:
            return "'if' condition";
        case ts.SyntaxKind.WhileStatement:
            return "'while' condition";
        case ts.SyntaxKind.DoStatement:
            return "'do-while' condition";
        case ts.SyntaxKind.BinaryExpression:
            return `operand for the '${binaryBooleanExpressionKind(n)}' operator`;
    }
}
function showFailure(location, ty, unionType, options) {
    const expectedTypes = showExpectedTypes(options);
    const expected = expectedTypes.length === 1 ?
        `Only ${expectedTypes[0]}s are allowed` :
        `Allowed types are ${stringOr(expectedTypes)}`;
    const tyFail = showTypeFailure(ty, unionType, options.strictNullChecks);
    return `This type is not allowed in the ${showLocation(location)} because it ${tyFail}. ${expected}.`;
}
function showExpectedTypes(options) {
    const parts = ["boolean"];
    if (options.allowNullUnion) {
        parts.push("null-union");
    }
    if (options.allowUndefinedUnion) {
        parts.push("undefined-union");
    }
    if (options.allowString) {
        parts.push("string");
    }
    if (options.allowEnum) {
        parts.push("enum");
    }
    if (options.allowNumber) {
        parts.push("number");
    }
    if (options.allowBooleanOrUndefined) {
        parts.push("boolean-or-undefined");
    }
    return parts;
}
function showTypeFailure(ty, unionType, strictNullChecks) {
    const is = unionType ? "could be" : "is";
    switch (ty) {
        case 0 /* TypeFailure.AlwaysTruthy */:
            return strictNullChecks ?
                "is always truthy" :
                "is always truthy. It may be null/undefined, but neither " +
                    `'${OPTION_ALLOW_NULL_UNION}' nor '${OPTION_ALLOW_UNDEFINED_UNION}' is set`;
        case 1 /* TypeFailure.AlwaysFalsy */:
            return "is always falsy";
        case 2 /* TypeFailure.String */:
            return `${is} a string`;
        case 3 /* TypeFailure.Number */:
            return `${is} a number`;
        case 4 /* TypeFailure.Null */:
            return `${is} null`;
        case 5 /* TypeFailure.Undefined */:
            return `${is} undefined`;
        case 6 /* TypeFailure.Enum */:
            return `${is} an enum`;
        case 8 /* TypeFailure.Promise */:
            return "promise handled as boolean expression";
        case 7 /* TypeFailure.Mixes */:
            return "unions more than one truthy/falsy type";
    }
}
function isTypeFlagSet(obj, flag) {
    return (obj.flags & flag) !== 0;
}
export default rule;
