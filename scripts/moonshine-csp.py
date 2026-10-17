"""Replace the two Emscripten dynamic invoker factories with equivalent closures.

The upstream 0.1.5 binary is unchanged. MV3 forbids the generated JS's new
Function even with wasm-unsafe-eval. Fail closed on upstream source changes.
"""
import re


def patch(source):
    start = source.index('function craftInvokerFunction(')
    end = source.index('var __embind_register_class_constructor=', start)
    source = source[:start] + '''function craftInvokerFunction(humanName,argTypes,classType,cppInvokerFunc,cppTargetFunc,isAsync){
var isMethod=argTypes[1]!==null&&classType!==null;
var stacked=usesDestructorStack(argTypes),returns=argTypes[0].name!=="void";
if(isAsync)throwBindingError("Async bindings are not supported by the MV3 closure adapter");
return createNamedFunction(humanName,function(...values){
var destructors=stacked?[]:null,wired=[cppTargetFunc];
if(isMethod)wired.push(argTypes[1].toWireType(destructors,this));
for(var i=2;i<argTypes.length;i++)wired.push(argTypes[i].toWireType(destructors,values[i-2]));
var rv=cppInvokerFunc(...wired);
if(stacked)runDestructors(destructors);
else for(var i=isMethod?1:2;i<argTypes.length;i++)if(argTypes[i].destructorFunction!==null)argTypes[i].destructorFunction(wired[isMethod?i:i-1]);
if(returns)return argTypes[0].fromWireType(rv);
});}
''' + source[end:]
    start = source.index('function __emval_get_method_caller(')
    end = source.index('function __emval_get_property(', start)
    source = source[:start] + '''function __emval_get_method_caller(argCount,argTypes,kind){
var types=emval_lookupTypes(argCount,argTypes>>>0),retType=types.shift();
return emval_addMethodCaller(function(obj,func,destructorsRef,args){
var values=[],offset=0;
for(var type of types){values.push(type.readValueFromPointer(args+offset));offset+=type.argPackAdvance;}
var rv=kind===1?Reflect.construct(func,values):func.call(obj,...values);
if(!retType.isVoid)return emval_returnValue(retType,destructorsRef,rv);
});}
''' + source[end:]
    if re.search(r'new Function|\beval\(', source):
        raise RuntimeError('Unexpected dynamic JavaScript remains in Moonshine')
    return source
