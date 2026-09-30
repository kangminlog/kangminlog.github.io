# kangminlog.github.io

GitHub Pages 블로그. 빌드 도구를 로컬에 깔지 않는다 — 깃허브가 Jekyll 로 만든다.

## 글 추가

`_posts/YYYY-MM-DD-영문-제목.md` 를 만들고 맨 위에 넣는다.

```
---
layout: post
title: "제목"
date: 2026-09-30 09:00:00 +0900
---
```

나머지는 마크다운이다. `git push` 하면 1~2분 뒤 반영된다.

## 로컬에서 미리 보기 (선택)

```
bundle exec jekyll serve
```

Ruby 와 Jekyll 이 필요하다. 없어도 push 해서 확인하면 된다.
