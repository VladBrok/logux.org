import glob from 'fast-glob'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import rehypeRaw from 'rehype-raw'
import remarkHighlight from 'remark-highlight.js'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import { unified } from 'unified'
import unistFlatmap from 'unist-util-flatmap'
import { visit } from 'unist-util-visit'

import { PROJECTS } from '../lib/dirs.js'
import wrap from '../lib/spinner.js'

const ROOT = join(PROJECTS, 'logux-docs')

function text(value) {
  return { type: 'text', value }
}

function span(cls, value) {
  return {
    children: [text(value)],
    properties: { className: [cls] },
    tagName: 'span',
    type: 'element'
  }
}

function highlightLines(node, cb) {
  if (!node.data) node.data = {}
  node.data.hChildren = node.value
    .split('\n')
    .map(cb)
    .flatMap((line, i) => (i === 0 ? line : [text('\n'), ...line]))
}

function iniandBashHighlight() {
  return tree => {
    visit(tree, 'code', node => {
      if (node.lang === 'sh' || node.lang === 'bash') {
        highlightLines(node, line =>
          line
            .split(' ')
            .map((word, i, all) => {
              if (i === 0 && (word === 'npx' || word === 'sudo')) {
                return span('code-block_keyword', word)
              } else if (
                i === 0 ||
                (i === 1 && all[0] === 'npx') ||
                (i === 1 && all[0] === 'npm' && word === 'i') ||
                (i === 1 && all[0] === 'yarn' && word === 'add') ||
                (i === 1 && all[0] === 'pnpm' && word === 'add')
              ) {
                return span('code-block_literal', word)
              } else {
                return text(word)
              }
            })
            .flatMap((word, i) => (i === 0 ? word : [text(' '), word]))
        )
      } else if (node.lang === 'ini') {
        highlightLines(node, line => {
          let [name, value] = line.split('=')
          return [
            span('code-block_params', name),
            text('='),
            span('code-block_string', value)
          ]
        })
      } else if (node.lang === 'diff') {
        highlightLines(node, line => {
          let code = line.slice(2)
          if (line[0] === '+') {
            return [span('code-block_addition', code)]
          } else if (line[0] === '-') {
            return [span('code-block_deletion', code)]
          } else {
            return [span('code-block_untouched', code)]
          }
        })
      }
    })
  }
}

function articler(file) {
  return tree => {
    tree.children = [
      {
        children: tree.children.filter(i => {
          if (i.tagName === 'h1') {
            i.editUrl = `https://github.com/logux/docs/edit/main/${file}`
            i.noSlug = true
          }
          return i.type !== 'text' || i.value !== '\n'
        }),
        properties: {},
        tagName: 'article',
        type: 'element'
      }
    ]
  }
}

function tag(tagName, properties, children) {
  return { children, properties, tagName, type: 'element' }
}

function textContent(node) {
  if (node.type === 'text') {
    return node.value
  } else if (node.children) {
    return node.children.map(i => textContent(i)).join('')
  } else {
    return ''
  }
}

function videoInserter() {
  return tree => {
    unistFlatmap(tree, node => {
      if (node.tagName === 'p' && textContent(node).startsWith('Youtube:')) {
        let match = textContent(node).match(/Youtube:(\S+) (.*)$/)
        let id = match[1]
        let alt = match[2]
        return [
          tag(
            'a',
            {
              className: ['video'],
              href: `https://www.youtube.com/watch?v=${id}`
            },
            [
              tag('picture', {}, [
                tag('source', {
                  srcset: `https://i.ytimg.com/vi_webp/${id}/maxresdefault.webp`,
                  type: 'image/webp'
                }),
                tag('img', {
                  alt,
                  src: `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`
                })
              ])
            ]
          )
        ]
      } else {
        return [node]
      }
    })
  }
}

function html(value) {
  return { type: 'html', value }
}

function npmToYarn(value) {
  return value
    .replace(/^npm i(nstall)? /, 'yarn add ')
    .replace(/--save-dev/, '--dev')
    .replace(/^npm /, 'yarn ')
}

function npmToPnpm(value) {
  return value
    .replace(/^npm i(nstall)? /, 'pnpm add ')
    .replace(/^npm /, 'pnpm ')
}

function convertor({ file, onTitle }) {
  return tree => {
    if (file === 'README.md') {
      unistFlatmap(tree, node => {
        if (node.type === 'html' && node.value.includes('<img')) {
          return []
        } else {
          return [node]
        }
      })
    }
    unistFlatmap(tree, node => {
      if (node.lang === 'sh' && node.value.startsWith('npm ')) {
        return [
          html('<details><summary>npm</summary>'),
          node,
          html('</details>'),
          html('<details><summary>pnpm</summary>'),
          { lang: 'sh', type: 'code', value: npmToPnpm(node.value) },
          html('</details>'),
          html('<details><summary>Yarn</summary>'),
          { lang: 'sh', type: 'code', value: npmToYarn(node.value) },
          html('</details>')
        ]
      } else {
        return [node]
      }
    })
    visit(tree, node => {
      if (node.type === 'heading') {
        if (node.depth === 1) {
          onTitle(node.children[0].value)
        }
      } else if (node.type === 'link' || node.type === 'definition') {
        node.url = node.url
          .replace(/^..\//, '../../')
          .replace(/^.\//, '../')
          .replace(/\.md(#.+)?$/, '/$1')
      }
    })
  }
}

async function readDocs() {
  let files = await glob('**/*.md', { cwd: ROOT, ignore: ['node_modules'] })
  let guides = await Promise.all(
    files.map(async file => {
      let title = ''
      let md = await readFile(join(ROOT, file))
      let tree = await unified().use(remarkParse).parse(md)
      tree = await unified()
        .use(convertor, {
          file,
          onTitle(value) {
            title = value
          }
        })
        .use(iniandBashHighlight)
        .use(remarkHighlight, {
          exclude: ['bash', 'sh', 'ini', 'diff'],
          prefix: 'code-block_'
        })
        .use(remarkRehype, { allowDangerousHtml: true })
        .use(rehypeRaw)
        .use(articler, file)
        .use(videoInserter)
        .run(tree)
      return { file, title, tree }
    })
  )
  return guides
}

export default wrap(readDocs, 'Reading docs')
