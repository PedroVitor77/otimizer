# ⚡ PulsePC — Diagnóstico de Saúde & Otimizador Pro

Aplicativo Desktop para Windows com interface gráfica moderna (Dark Mode via WebView2 nativo) para monitoramento de saúde em tempo real, limpeza segura de arquivos inúteis, localização de arquivos pesados/duplicados e otimização completa de desempenho.

---

## 📥 Download do Instalador

Para instalar o aplicativo no Windows sem precisar de Python:

👉 **[Baixar PulsePC_Setup.exe (v1.0.0)](https://github.com/PedroVitor77/otimizer/releases/latest/download/PulsePC_Setup.exe)**

Ou acesse a página de releases: [GitHub Releases v1.0.0](https://github.com/PedroVitor77/otimizer/releases/tag/v1.0.0)

---

## 🚀 Como Iniciar o Programa (Modo Desenvolvedor)

### Opção 1: Atalho de 1 Clique (Recomendado)
Dê dois cliques no arquivo:
- **`Iniciar_PulsePC.bat`** (Solicita permissão de Administrador automaticamente para poder total de limpeza e otimização e abre a janela Desktop nativa do aplicativo).

### Opção 2: Via Terminal
```powershell
python app.py
```
*(Ou `python app.py --browser` caso prefira abrir diretamente no navegador padrão).*

---

## 🛠️ Funcionalidades Incluídas

1. **Painel de Saúde da Máquina (Dashboard em Tempo Real)**
   - **Score de Saúde (0–100%)** dinâmico com diagnóstico automático de gargalos.
   - **Otimização Rápida em 1 Clique (Super Boost)**: libera memória RAM ociosa, limpa arquivos temporários seguros e limpa o cache DNS simultaneamente.
   - **Monitoramento ao Vivo**: CPU (total, frequência e por thread), Memória RAM, Atividade de Leitura/Escrita de Disco (MB/s), Rede (Download/Upload), GPU e Saúde Física dos SSDs/HDs (**S.M.A.R.T.**).

2. **Limpador Inteligente de Arquivos Inúteis**
   - Analisa e exibe pré-visualização detalhada antes de apagar:
     - Arquivos Temporários do Usuário (`%TEMP%`) e do Windows (`C:\Windows\Temp`)
     - Cache `Prefetch` do Sistema
     - Cache de Navegadores (Chrome, Edge, Brave, Opera, Vivaldi, Firefox — **preservando 100% das senhas, logins e histórico**)
     - Caches de Aplicativos e Shaders (Discord, Spotify, VSCode, NVIDIA/AMD DXCache)
     - Cache de Downloads do Windows Update (`SoftwareDistribution\Download`)
     - Relatórios de Erros (WER), CrashDumps, Logs e Miniaturas (`thumbcache`)
     - Lixeira do Windows

3. **Scanner de Arquivos Grandes e Espaço em Disco**
   - Filtra arquivos por tamanho (`> 50 MB`, `> 100 MB`, `> 500 MB`, `> 1 GB`) e por categoria (`Vídeos & Mídia`, `ISOs & Instaladores`, `Compactados & Backups`, `Jogos, IA & Dados`, `Projetos & Bancos de Dados`).
   - Mostra gráfico de distribuição por tipo e as pastas que mais acumulam espaço.
   - Permite **Abrir na Pasta (Explorer)**, **Mover para a Lixeira** ou **Excluir Permanentemente**, com **Trava de Segurança** automática que impede a exclusão acidental de arquivos vitais do Windows.

4. **Localizador de Arquivos Duplicados (SHA-256)**
   - Compara tamanho + hash parcial + assinatura criptográfica SHA-256 para encontrar arquivos 100% idênticos.
   - Botão de 1 clique para marcar apenas as **Cópias Extras** (preservando o arquivo original mais antigo).

5. **Centro de Otimização & Modo Turbo**
   - **Otimizador de Memória RAM**: libera o *Working Set* de processos em segundo plano via API nativa do Windows (`EmptyWorkingSet`).
   - **Modo Turbo**: ativa o plano de energia de *Alto Desempenho / Desempenho Máximo*, reduz a prioridade de processos pesados em segundo plano e otimiza a RAM.
   - **Otimizador de Rede & Ping**: executa `ipconfig /flushdns`, limpa cache NetBIOS e mede a latência (ms) para Cloudflare (`1.1.1.1`) e Google (`8.8.8.8`).
   - **Tweaks Seguros do Windows**: chaves reversíveis para desativar Xbox Game DVR em 2º plano, acelerar abertura de menus (20ms), desativar transparências pesadas, otimizar efeitos visuais do Explorer e bloquear sugestões/anúncios no Menu Iniciar.

6. **Gerenciador de Processos, Inicialização (Boot) e Programas**
   - **Processos em Tempo Real**: identifica automaticamente "Vilões de Recursos" e permite encerrá-los com 1 clique (protegendo processos críticos do Windows).
   - **Programas de Inicialização**: ative ou desative programas do Registro (`HKCU`/`HKLM`) e da pasta `Startup` para deixar o boot do Windows muito mais rápido.
   - **Desinstalador de Programas**: lista todos os softwares instalados ordenados por tamanho estimado e abre o desinstalador oficial.

7. **Reparo do Windows, Ficha Técnica & Histórico**
   - Criação de **Ponto de Restauração do Sistema** em 1 clique.
   - Execução guiada de `SFC /scannow`, `DISM /CheckHealth` & `/RestoreHealth` e `CHKDSK`.
   - **Ficha Técnica Completa** (CPU, Placa-Mãe, BIOS, GPU, Pentes de RAM e Discos S.M.A.R.T.) com botão de cópia rápida.
   - **Histórico Persistente** de espaço em disco e memória RAM já recuperados pelo programa.
