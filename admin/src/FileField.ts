import { FieldProps, StringField } from './Form'
import { createElement as h } from 'react'
import { InputAdornment } from '@mui/material'
import { Eject } from '@mui/icons-material'
import { IconBtn } from './misc'
import { newDialog } from '@hfs/shared/lib/dialogs'
import FilePicker from './FilePicker'
import { apiCall } from './api'

export default function FileField({ value, onChange, ...props }: FieldProps<string>) {
    return h(StringField, {
        ...props,
        value,
        onChange,
        InputProps: {
            endAdornment: h(InputAdornment, { position: 'end' },
                h(IconBtn, {
                    icon: Eject,
                    title: "Browse files...",
                    edge: 'end',
                    onClick() {
                        const close = newDialog({
                            title: "Pick a file",
                            dialogProps: { sx:{ minWidth:'min(90vw, 40em)', minHeight: 'calc(100vh - 9em)' } },
                            Content,
                        })

                        function Content() {
                            return h(FilePicker, {
                                multiple: false,
                                from: value,
                                async onSelect(sel) {
                                    let one = sel?.[0]
                                    if (!one) return
                                    const cwd = (await apiCall('get_cwd'))?.path
                                    if (one.startsWith(cwd))
                                        one = one.slice(cwd.length+1)
                                    onChange(one, { was: value, event: 'picker' })
                                    close()
                                }
                            })
                        }
                    },
                }))
        }
    })
}
