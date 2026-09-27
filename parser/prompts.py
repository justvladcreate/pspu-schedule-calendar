# parser/prompts.py
"""Промпты для AI-парсера."""

USER_PROMPT = """You are a parser for university schedules. You receive a full group input string, containing a discipline info line. For each input string, output one or more structured lines in the strict format:

[<enumerator>];<day_of_week>;<time_start>;<time_end>;<dates>;<discipline_name>;<type>;<subgroup>;<teachers>;<rooms>

If a field is missing, write a single dash "-" in its place.
Every field MUST be present between two ; characters, even if it contains only "-".
Never omit a ; and never collapse ";;" into ";".

Core Principles
Never invent or hallucinate disciplines, teachers, dates, rooms, or type values. Every token in the output must come from the input.

The only allowed transformations are the ones explicitly described in Steps 3–8 below:
- collapsing a parenthesised type like (лек. прак.) → лек.прак.;
- unifying the data like subgroups пг 1 → п/г 1
- trimming leading/trailing spaces, commas, and dots from the discipline;
- dropping a stray preposition в/с right after the date part.
Do not perform any other normalisation, rewriting, or synonym substitution.

Output order must follow the order of the branches inside each input string.

Branching is driven only by a change in discipline, type, or subgroup – never by a change in dates or teachers.

Step‑by‑Step Processing
1. Segment into event branches
A new branch is created exclusively when one of these three things changes:

Discipline name (the main subject, including notes like "(ТЕСТИРОВАНИЕ)", "ЯВКА СТУДЕНТОВ ОБЯЗАТЕЛЬНО")
Class type (лек., прак., лаб., лек.прак., or equivalent standalone keywords)
Subgroup (п/г 1, п/г 2)

time, dates, room changes, or remarks (ЯВКА, ЭКСКУРСИЯ, etc.) never create a new branch.

When scanning the text from left to right, start one branch for the first combination of (discipline, type, subgroup). Whenever you encounter a later piece that clearly belongs to a different discipline, type, or subgroup, close the current branch and start a new one. All dates seen while a branch is active belong to that branch.

Example of branching:

text
2.02 - 6.04 Иностранный язык (прак.), п/г 1 ст. преп. Карсукова Н.К. 16.02 - 6.04 Иностранный язык (прак.), п/г 2 преп. Марченко О.В.
→ Branch 1: discipline Иностранный язык, type прак., subgroup п/г 1 (dates 2.02 - 6.04)
→ Branch 2: same discipline and type but subgroup changed to п/г 2, so new branch (dates 16.02 - 6.04)

Do not split into a new branch when the discipline name remains the same and only the date changes, even if a standalone прак. or лек. appears later that refers to the same discipline with no actual type change.

Do not change the order of branches from order of appearance in the text. Preserve the original ordering that is met in the raw text.  

2. Extract the time (only if present). There are two cases:
a) Time at the very start of the input element, before any date. It applies to every branch derived from that element.
b) Time attached to one specific date inside the element — e.g. 11.09 в 13.30 <discipline> or 11.09 в 13.30 <discipline> ... <other dates> <other discipline>. In this case the time belongs only to that branch. All other branches of the same element must keep - in time_start and time_end unless they have their own explicit time.

3. Extract the dates for each branch (only if present)
Within a branch, collect all date expressions from the start until the discipline name begins. Dates are written as:
single dates: 13.02
comma lists: 3.02, 10.02
ranges: 9.02 - 7.07
mixed: 11.02 - 15.04, 22.04 - 29.06

If a stray preposition like в or с appears near the date part (e.g., 25.04 в, с 25.04), drop that в, с from the date string. The resulting dates field contains only the pure date expression(s), exactly as in the original, joined by commas if multiple.

4. Extract the class type
Look for the type in two ways, in order:
a) Parenthesised type: If an abbreviation inside parentheses consists only of the tokens лек., прак., лаб. (possibly with dots and spaces), that is the type.
Collapse spaces: (лек. прак.) → type лек.прак.; (лаб. прак) → лаб.прак.; (лек.) → лек..
Remove those parentheses and their content from the remaining text.
b) Standalone keyword: If no parenthesised type was found, scan the text after the dates for a standalone word that is a known type keyword: лек., прак., лаб., лек.прак., семинар, практика. If found, take it as the type and remove it from the discipline text.
If the parentheses contain anything else (e.g., (ТЕСТИРОВАНИЕ), (ЗАЧЕТ), (ДЕБАТЫ)), do not treat it as type; keep those parentheses as part of the discipline name.

5. Extract the subgroup
Find the pattern п/г (or пг) optionally followed by a space and a digit (usually 1 or 2). Store "п/г N" (e.g. "п/г 1") in subgroup.

6. Extract the teachers
Teacher names consist of a title (one of ст.преп., ст. преп., доц., преп., проф., асс., рук-ль., отв.) followed by a Russian surname and initials (e.g., Карсукова Н.К.). If multiple titles/names are present, join them with commas.

Hour annotations of the form "-Nч" (e.g. "-22ч", "-8ч") belong to the teachers field: they immediately follow the teacher name and are part of that teacher's workload, so append them to the teacher string.


If no teacher appears in the branch, look ahead to later parts of the same element’s text (if available) – sometimes the teacher is given only after all branches. If still not found, write a single dash "-" in the teachers field, as required by the output format.

7. Assemble the discipline
After removing the date and time part, type parentheses, subgroup token, and teacher string, the remaining text is the discipline. Trim leading/trailing spaces, commas, and dots. If the discipline includes notes like (ТЕСТИРОВАНИЕ) or "ЯВКА СТУДЕНТОВ ОБЯЗАТЕЛЬНА", keep them as part of the discipline name.

8. Assign rooms (if present)
If rooms info is explicitly given, try assigning it accordingly to branches. Rooms may contain info like "IV к. А331, дистанционно онлайн, IV к. холл 2 эт., I к. А101"

Output Format
For each branch, output exactly one line:

text
[<enumerator>];<day_of_week>;<time_start>;<time_end>;<dates>;<discipline_name>;<type>;<subgroup>;<teachers>;<rooms>
No other text. Fields are separated by ;.

Priority Rules (in case of doubt)
Preserve the original sequence and meaning of every token; only the transformations listed in Steps 3–8 are allowed.
Never split a branch because of a date change.
Branch only when discipline, type, or subgroup changes.
If a type keyword appears ambiguous, rely on the parenthesised form first.

Examples
Example 1 – single element, multiple branches, no day of week, no time, no rooms
Input:
[1] 2.02.2026 - 6.04.2026 Иностранный язык (прак.), п/г 1 ст. преп. Карсукова Н.К. 16.02.2026 - 6.04.2026 Иностранный язык (прак.), п/г 2 преп. Марченко О.В.
Output:
[1];-;-;-;2.02.2026 - 6.04.2026;Иностранный язык;прак.;п/г 1;ст. преп. Карсукова Н.К.;-
[1];-;-;-;16.02.2026 - 6.04.2026;Иностранный язык;прак.;п/г 2;преп. Марченко О.В.;-

Example 2 – multiple elements, keeping the enumerator, no day of week, no time, no rooms
Input:
[1] с 10.09.2026 Русский язык (прак.), преп. Штейникова В.И;-
[2] 20.10.2026 Русский язык (прак.), преп. Колесникова О.В.;-

Output:
[1];-;-;-;10.09.2026;Русский язык;прак.;-;преп. Штейникова В.И;-
[2];-;-;-;20.10.2026;Русский язык;прак.;-;преп. Колесникова О.В.;-

Example 3 – no day of week, no time, notes kept, no subgroups, no rooms
Input:
[1] 24.02.2026 - 21.04.2026 Общая и социальная психология (прак.) доц. Баландина Л.Л. ЯВКА ОБЯЗАТЕЛЬНА 28.04.2026 Общая и социальная психология (ТЕСТИРОВАНИЕ) доц. Баландина Л.Л.
Output:
[1];-;-;-;24.02.2026 - 21.04.2026;Общая и социальная психология ЯВКА ОБЯЗАТЕЛЬНО;прак.;-;доц. Баландина Л.Л.;-
[1];-;-;-;28.04.2026;Общая и социальная психология (ТЕСТИРОВАНИЕ);-;-;доц. Баландина Л.Л.;-

Example 4 – stray preposition dropped, rooms given
Input:
[1] 25.04.2026 в История России (прак.) преп. Штейников С.Н IV к. А314.
Output:
[1];-;-;-;25.04.2026;История России;прак.;-;преп. Штейников С.Н.;IV к. А314

Example 5 – Junk info cleaned
Input:
[1] 11.09.2026 в Компьютерная и информационная безопасность (лек/..), 11.09.2026 - 30.10.2026 Компьютерная и информационная безопасность (прак.) доц. Зорин А.А. -22ч		
Output:
[1];-;-;-;11.09.2026;Компьютерная и информационная безопасность;лек.;-;доц. Зорин А.А. -22ч;-
[1];-;-;-;11.09.2026 - 30.10.2026;Компьютерная и информационная безопасность;прак.;-;доц. Зорин А.А. -22ч;-

Example 6 – No info
Input:
[1] Физическая культура
Output:
[1];-;-;-;-;Физическая культура;-;-;-;-

Example 7 – Time variations
Input:
[1] 11.09 в 13.30 Современная образовательная среда (Технопарк) преп. Терехина А.В. 18.09 Культурно-просветительский практикум доц. Порозов В.А. 9.10, 16.10 Основы медицинских знаний (лек.) доц. Отавина М.Л.

Output:
[1];-;13.30;-;11.09;Современная образовательная среда (Технопарк);-;-;преп. Терехина А.В.;-
[1];-;-;-;18.09;Культурно-просветительский практикум;-;-;доц. Порозов В.А.;-
[1];-;-;-;9.10, 16.10;Основы медицинских знаний;лек.;-;доц. Отавина М.Л.;-

Apply these instructions to every input string you receive.

Input data:
{data}"""