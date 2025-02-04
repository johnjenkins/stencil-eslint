import { getDecoratorList, isPrivate, stencilComponentContext, stencilDecorators, stencilLifecycle, } from "../utils";
const rule = {
    meta: {
        docs: {
            description: "This rule catches own class methods marked as public.",
            category: "Possible Errors",
            recommended: true,
        },
        schema: [],
        type: 'problem',
        fixable: 'code',
    },
    create(context) {
        const stencil = stencilComponentContext();
        const parserServices = context.sourceCode.parserServices;
        return {
            ...stencil.rules,
            "MethodDefinition[kind=method]": (node) => {
                if (!stencil.isComponent()) {
                    return;
                }
                const originalNode = parserServices.esTreeNodeToTSNodeMap.get(node);
                const decorators = getDecoratorList(originalNode);
                const stencilDecorator = decorators &&
                    decorators.some((dec) => stencilDecorators.includes(dec.expression.expression.escapedText));
                const stencilCycle = stencilLifecycle.includes(originalNode.name.escapedText);
                if (!stencilDecorator && !stencilCycle && !isPrivate(originalNode)) {
                    context.report({
                        node: node,
                        message: `Own class methods cannot be public`,
                        fix(fixer) {
                            const sourceCode = context.getSourceCode();
                            const tokens = sourceCode.getTokens(node);
                            const publicToken = tokens.find(token => token.value === 'public');
                            if (publicToken) {
                                return fixer.replaceText(publicToken, 'private');
                            }
                            else {
                                return fixer.insertTextBefore(node.key, 'private ');
                            }
                        }
                    });
                }
            },
        };
    },
};
export default rule;
