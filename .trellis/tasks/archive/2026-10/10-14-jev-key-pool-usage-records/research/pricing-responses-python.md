> ## Documentation Index > Fetch the complete documentation index at: https://docs.typesafe.ai/llms.txt > Use this file to discover all available pages before exploring further. # Answers and responses > Read answers, confidence scores, token usage, and available models returned by the TypeSafe API. export function SdkSignature({children}) { async function copy(event) { const button = event.currentTarget; const code = button.parentElement.querySelector("pre code"); try { await navigator.clipboard.writeText(code.textContent); button.setAttribute("aria-label", "Signature copied"); button.dataset.copied = "true"; } catch { button.setAttribute("aria-label", "Copy failed; select the signature to copy"); } setTimeout(() => { button.setAttribute("aria-label", "Copy signature"); delete button.dataset.copied; }, 2000); } return
; } 

## Response

## typesafe\\_sdk.SystemOneResponse

Bases: `Response` Answers grouped by question type with model and usage metadata. See [System One](https://docs.typesafe.ai/concepts/system-one) for details.

### request\\_id

`cached` `property`   {"request\_id"}   {":"}  {" "}   [{"str"}](https://docs.python.org/3/builtins/stdtypes.html#str)   {"\n"}  The `x-typesafe-request-id` response header.

### raw\\_http\\_response

`property` ```python theme={null} raw\_http\_response: httpx2.Response ``` The underlying `httpx2.Response`, exposing status, headers, and body.

### model

`instance-attribute`   {"model"}   {":"}  {" "}   [{"str"}](https://docs.python.org/3/builtins/stdtypes.html#str)   {"\n"}  The model used to answer the request.

### usage

`instance-attribute`   {"usage"}   {":"}  {" "}   [{"Usage"}](/sdk/python/api/types/responses#typesafe_sdk.Usage)   {"\n"}  Token usage for the request.

### answers

`class-attribute` `instance-attribute`  {"answers"}{":"}{" "}[{"dict"}](https://docs.python.org/3/builtins/stdtypes.html#dict){"["}[{"str"}](https://docs.python.org/3/builtins/stdtypes.html#str){","}{" "}[{"Answer"}](/sdk/python/api/types/responses#typesafe_sdk.Answer){"]"}{" "}{"="}{" "}[{"field"}](https://msgspec.dev/api.html#msgspec.field){"("}{"\n"}{" "}{"default\_factory"}{"="}[{"dict"}](https://docs.python.org/3/builtins/stdtypes.html#dict){"\n"}{")"}{"\n"}  All answer objects keyed by question name.

### nouls

`cached` `property`   {"nouls"}   {":"}  {" "}   [{"dict"}](https://docs.python.org/3/builtins/stdtypes.html#dict)    {"["}    [{"str"}](https://docs.python.org/3/builtins/stdtypes.html#str)    {","}  {" "}   [{"NoulAnswer"}](/sdk/python/api/types/responses#typesafe_sdk.NoulAnswer)    {"]"}  {"\n"}  Yes/no answers keyed by question name.

### choices

`cached` `property`   {"choices"}   {":"}  {" "}   [{"dict"}](https://docs.python.org/3/builtins/stdtypes.html#dict)    {"["}    [{"str"}](https://docs.python.org/3/builtins/stdtypes.html#str)    {","}  {" "}   [{"ChoiceAnswer"}](/sdk/python/api/types/responses#typesafe_sdk.ChoiceAnswer)    {"]"}  {"\n"}  Choice answers keyed by question name.

### scores

`cached` `property`   {"scores"}   {":"}  {" "}   [{"dict"}](https://docs.python.org/3/builtins/stdtypes.html#dict)    {"["}    [{"str"}](https://docs.python.org/3/builtins/stdtypes.html#str)    {","}  {" "}   [{"ScoreAnswer"}](/sdk/python/api/types/responses#typesafe_sdk.ScoreAnswer)    {"]"}  {"\n"}  Score answers keyed by question name.

## typesafe\\_sdk.Usage

Bases: `msgspec.Struct` Token counts for a request, when reported by the API.

### input\\_tokens

`class-attribute` `instance-attribute`   {"input\_tokens"}   {":"}  {" "}   [{"int"}](https://docs.python.org/3/builtins/functions.html#int)   {" "}  {"|"}  {" "}  {"None"}  {" "}  {"="}  {" "}  {"None"}  {"\n"}  Number of input tokens used, or `None` when the API did not report it.

### output\\_tokens

`class-attribute` `instance-attribute`   {"output\_tokens"}   {":"}  {" "}   [{"int"}](https://docs.python.org/3/builtins/functions.html#int)   {" "}  {"|"}  {" "}  {"None"}  {" "}  {"="}  {" "}  {"None"}  {"\n"}  Number of output tokens used, or `None` when the API did not report it.

## Answers

## typesafe\\_sdk.NoulAnswer

Bases: `wire.NoulAnswer` A yes/no answer. See the [noul primitive](https://docs.typesafe.ai/primitives/noul) for details.

### noul

`instance-attribute`   {"noul"}   {":"}  {" "}   [{"float"}](https://docs.python.org/3/builtins/functions.html#float)   {"\n"}  Probability of a yes answer, from zero to one.

## typesafe\\_sdk.ChoiceAnswer

Bases: `wire.ChoiceAnswer` A selected label and its probabilities. See the [choice primitive](https://docs.typesafe.ai/primitives/choice) for details.

### choice

`instance-attribute`   {"choice"}   {":"}  {" "}   [{"str"}](https://docs.python.org/3/builtins/stdtypes.html#str)   {"\n"}  The selected label.

### confidence

`instance-attribute`   {"confidence"}   {":"}  {" "}   [{"float"}](https://docs.python.org/3/builtins/functions.html#float)   {"\n"}  Reported confidence in the selected label.

### probabilities

`instance-attribute`   {"probabilities"}   {":"}  {" "}   [{"dict"}](https://docs.python.org/3/builtins/stdtypes.html#dict)    {"["}    [{"str"}](https://docs.python.org/3/builtins/stdtypes.html#str)    {","}  {" "}   [{"float"}](https://docs.python.org/3/builtins/functions.html#float)    {"]"}  {"\n"}  Probabilities keyed by label.

## typesafe\\_sdk.ScoreAnswer

Bases: `wire.ScoreAnswer` An expected score with its rubric and probabilities. See the [score primitive](https://docs.typesafe.ai/primitives/score) for details.

### score

`instance-attribute`   {"score"}   {":"}  {" "}   [{"float"}](https://docs.python.org/3/builtins/functions.html#float)   {"\n"}  Expected score, which may fall between the integer rubric levels.

### confidence

`instance-attribute`   {"confidence"}   {":"}  {" "}   [{"float"}](https://docs.python.org/3/builtins/functions.html#float)   {"\n"}  Reported confidence in the score.

### legend

`instance-attribute`  {"legend"}{":"}{" "}[{"dict"}](https://docs.python.org/3/builtins/stdtypes.html#dict){"["}{"\n"}{" "}[{"int"}](https://docs.python.org/3/builtins/functions.html#int){","}{" "}[{"str"}](https://docs.python.org/3/builtins/stdtypes.html#str){" "}{"|"}{" "}[{"dict"}](https://docs.python.org/3/builtins/stdtypes.html#dict){"["}[{"str"}](https://docs.python.org/3/builtins/stdtypes.html#str){","}{" "}[{"Any"}](https://docs.python.org/3/library/typing.html#typing.Any){"]"}{" "}{"|"}{" "}[{"list"}](https://docs.python.org/3/builtins/stdtypes.html#list){"["}[{"Any"}](https://docs.python.org/3/library/typing.html#typing.Any){"]"}{"\n"}{"]"}{"\n"}  Rubric descriptions keyed by integer score.

### probabilities

`instance-attribute`   {"probabilities"}   {":"}  {" "}   [{"dict"}](https://docs.python.org/3/builtins/stdtypes.html#dict)    {"["}    [{"int"}](https://docs.python.org/3/builtins/functions.html#int)    {","}  {" "}   [{"float"}](https://docs.python.org/3/builtins/functions.html#float)    {"]"}  {"\n"}  Probabilities keyed by integer score.

## typesafe\\_sdk.Answer

`module-attribute`  {"Answer"}{":"}{" "}[{"TypeAlias"}](https://docs.python.org/3/library/typing.html#typing.TypeAlias){" "}{"="}{" "}{"("}{"\n"}{" "}[{"NoulAnswer"}](/sdk/python/api/types/responses#typesafe_sdk.NoulAnswer){" "}{"|"}{" "}[{"ChoiceAnswer"}](/sdk/python/api/types/responses#typesafe_sdk.ChoiceAnswer){" "}{"|"}{" "}[{"ScoreAnswer"}](/sdk/python/api/types/responses#typesafe_sdk.ScoreAnswer){"\n"}{")"}{"\n"}  An answer to a single question, identified by its `type`.

## Available models

## typesafe\\_sdk.ListModelsResponse

Bases: `Response` The models available to the account.

### request\\_id

`cached` `property`   {"request\_id"}   {":"}  {" "}   [{"str"}](https://docs.python.org/3/builtins/stdtypes.html#str)   {"\n"}  The `x-typesafe-request-id` response header.

### raw\\_http\\_response

`property` ```python theme={null} raw\_http\_response: httpx2.Response ``` The underlying `httpx2.Response`, exposing status, headers, and body.

### models

`instance-attribute`   {"models"}   {":"}  {" "}   [{"tuple"}](https://docs.python.org/3/builtins/stdtypes.html#tuple)    {"["}    [{"ModelMetadata"}](/sdk/python/api/types/responses#typesafe_sdk.ModelMetadata)    {","}  {" "}  {"..."}   {"]"}  {"\n"}  The available models.

## typesafe\\_sdk.ModelMetadata

Bases: `Struct`

### name

`instance-attribute`   {"name"}   {":"}  {" "}   [{"str"}](https://docs.python.org/3/builtins/stdtypes.html#str)   {"\n"} 

### description

`instance-attribute`   {"description"}   {":"}  {" "}   [{"str"}](https://docs.python.org/3/builtins/stdtypes.html#str)   {"\n"} 

### release\\_date

`instance-attribute`   {"release\_date"}   {":"}  {" "}   [{"str"}](https://docs.python.org/3/builtins/stdtypes.html#str)   {"\n"}  
