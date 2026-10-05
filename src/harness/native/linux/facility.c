/* Linux x64 fixed private lifecycle/peer observer. No shell, runtime compiler, or logs.
 * Build: C11 + glibc; source/binary/build provenance is pinned by the Node bridge.
 * A subreaper owns adoption, pidfds bind every signal to a kernel process identity,
 * and waitpid(ECHILD), not group emptiness, is the final descendant-closure receipt.
 * This is an observer/launcher, not filesystem/network sandbox enforcement.
 */
#define _GNU_SOURCE
#include <sys/types.h>
#include <sys/stat.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/syscall.h>
#include <sys/prctl.h>
#include <sys/wait.h>
#include <sys/sysmacros.h>
#include <dirent.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <time.h>
#include <unistd.h>
#include <limits.h>

#define FRAME 1048576
#define CHUNK 16384
#define MAX_PIN 2050
#define MAX_ENTRY 8
#define MAX_ARG 64
#define MAX_OBS_ARG 512
#define MAX_PROC 256
#define MAX_PEER 16
#define MAX_TOKEN 24000
#define OUT_LIMIT 2097152
#define IPC_LIMIT 4194304
static uint64_t operation,cleanup_at,cleanup_end;
static uint64_t now_ms(void) { struct timespec t; if (clock_gettime(CLOCK_MONOTONIC,&t)) _exit(125); return (uint64_t)t.tv_sec*1000+(uint64_t)t.tv_nsec/1000000; }
static int pid_open(pid_t p) { return (int)syscall(SYS_pidfd_open,p,0); }
static int pid_signal(int fd,int s) { return (int)syscall(SYS_pidfd_send_signal,fd,s,NULL,0); }
static int nonblock(int fd) { int f=fcntl(fd,F_GETFL); return f<0 ? -1 : fcntl(fd,F_SETFL,f|O_NONBLOCK); }
static void close_fd(int *fd) { if (*fd>=0) { close(*fd); *fd=-1; } }

/* Dependency-free SHA-256 over held regular file descriptors. */
typedef struct { uint32_t h[8]; uint64_t bytes; unsigned used; unsigned char b[64]; } Sha;
static const uint32_t sk[64]={
0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2};
static uint32_t rr(uint32_t v,unsigned n) { return (v>>n)|(v<<(32-n)); }
static void sha_block(Sha *s) {
  uint32_t w[64]; for(unsigned i=0;i<16;i++) w[i]=((uint32_t)s->b[4*i]<<24)|((uint32_t)s->b[4*i+1]<<16)|((uint32_t)s->b[4*i+2]<<8)|s->b[4*i+3];
  for(unsigned i=16;i<64;i++) { uint32_t a=w[i-15],b=w[i-2]; w[i]=w[i-16]+(rr(a,7)^rr(a,18)^(a>>3))+w[i-7]+(rr(b,17)^rr(b,19)^(b>>10)); }
  uint32_t a=s->h[0],b=s->h[1],c=s->h[2],d=s->h[3],e=s->h[4],f=s->h[5],g=s->h[6],h=s->h[7];
  for(unsigned i=0;i<64;i++) { uint32_t x=h+(rr(e,6)^rr(e,11)^rr(e,25))+((e&f)^(~e&g))+sk[i]+w[i], y=(rr(a,2)^rr(a,13)^rr(a,22))+((a&b)^(a&c)^(b&c)); h=g;g=f;f=e;e=d+x;d=c;c=b;b=a;a=x+y; }
  s->h[0]+=a;s->h[1]+=b;s->h[2]+=c;s->h[3]+=d;s->h[4]+=e;s->h[5]+=f;s->h[6]+=g;s->h[7]+=h;
}
static void sha_init(Sha *s) { static const uint32_t init[8]={0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19}; memset(s,0,sizeof(*s)); memcpy(s->h,init,sizeof(init)); }
static void sha_add(Sha *s,const unsigned char *p,size_t n) { s->bytes+=n; while(n--) { s->b[s->used++]=*p++; if(s->used==64) {sha_block(s);s->used=0;} } }
static int hash_fd(int fd,char out[65]) {
  Sha s;sha_init(&s); unsigned char b[65536]; off_t off=0; ssize_t n;
  while((n=pread(fd,b,sizeof(b),off))>0) {
    off+=n;
    if(off>268435456||(operation&&now_ms()>=operation))return -1;
    sha_add(&s,b,(size_t)n);
  }
  if(n<0)return -1;
  uint64_t bits=s.bytes*8; unsigned char one=128,zero=0;sha_add(&s,&one,1);while(s.used!=56)sha_add(&s,&zero,1);
  unsigned char end[8];for(unsigned i=0;i<8;i++)end[7-i]=(unsigned char)(bits>>(i*8));sha_add(&s,end,8);
  for(unsigned i=0;i<8;i++) { int ignored=snprintf(out+i*8,9,"%08x",s.h[i]); (void)ignored; } out[64]=0;return 0;
}

/* Closed, bounded JSON RPC parser. Tokens retain no pointers into freed input. */
typedef struct { int type,start,end,next,size; } Token;
static Token tok[MAX_TOKEN];static int nt,pos,jlen;static char *json;
static void space(void) { while(pos<jlen&&(json[pos]==' '||json[pos]=='\r'||json[pos]=='\t'))pos++; }
static int hex(unsigned char c) { if(c>='0'&&c<='9')return c-'0';if(c>='a'&&c<='f')return c-'a'+10;if(c>='A'&&c<='F')return c-'A'+10;return -1; }
static int value(unsigned depth) {
  space();if(depth>16||pos>=jlen||nt>=MAX_TOKEN)return -1;int t=nt++;tok[t]=(Token){0,pos,0,0,0};char c=json[pos++];
  if(c=='"') {tok[t].type='s';tok[t].start=pos;while(pos<jlen&&json[pos]!='"'){unsigned char x=(unsigned char)json[pos++];if(x<32)return -1;if(x=='\\'){if(pos>=jlen)return -1;char e=json[pos++];if(e=='u'){for(int k=0;k<4;k++)if(pos>=jlen||hex((unsigned char)json[pos++])<0)return -1;}else if(!strchr("\"\\/bfnrt",e))return -1;}}if(pos>=jlen)return -1;tok[t].end=pos++;}
  else if(c=='{'||c=='[') {tok[t].type=c;space();char end=c=='{'?'}':']';if(pos<jlen&&json[pos]==end){pos++;}else for(;;){if(c=='{'){space();if(pos>=jlen||json[pos]!='"'||value(depth+1)<0)return -1;space();if(pos>=jlen||json[pos++]!=':')return -1;}if(value(depth+1)<0)return -1;tok[t].size++;space();if(pos>=jlen)return -1;if(json[pos]==end){pos++;break;}if(json[pos++]!=',')return -1;}tok[t].end=pos;}
  else {tok[t].type='n';while(pos<jlen&&!strchr(",]} \r\t",json[pos]))pos++;tok[t].end=pos;int n=pos-tok[t].start;const char *p=json+tok[t].start;if(!((n==4&&!memcmp(p,"true",4))||(n==5&&!memcmp(p,"false",5))||(n==4&&!memcmp(p,"null",4)))){int k=0;if(k<n&&p[k]=='-')k++;if(k>=n)return -1;if(p[k]=='0')k++;else{if(p[k]<'1'||p[k]>'9')return -1;while(k<n&&p[k]>='0'&&p[k]<='9')k++;}if(k<n&&p[k]=='.'){k++;int q=k;while(k<n&&p[k]>='0'&&p[k]<='9')k++;if(k==q)return -1;}if(k<n&&(p[k]=='e'||p[k]=='E')){k++;if(k<n&&(p[k]=='+'||p[k]=='-'))k++;int q=k;while(k<n&&p[k]>='0'&&p[k]<='9')k++;if(k==q)return -1;}if(k!=n)return -1;}}
  tok[t].next=nt;return t;
}
static char *string(int t) {
  if(t<0||tok[t].type!='s'){return NULL;}size_t cap=(size_t)(tok[t].end-tok[t].start)+1;char *s=malloc(cap);if(!s)return NULL;size_t n=0;
  for(int i=tok[t].start;i<tok[t].end;i++){unsigned char c=(unsigned char)json[i];if(c!='\\'){s[n++]=(char)c;continue;}c=(unsigned char)json[++i];if(c=='u'){unsigned v=0;for(int k=0;k<4;k++)v=v*16+(unsigned)hex((unsigned char)json[++i]);if(v>=0xd800&&v<=0xdbff){if(i+6>=tok[t].end||json[i+1]!='\\'||json[i+2]!='u'){free(s);return NULL;}i+=2;unsigned w=0;for(int k=0;k<4;k++)w=w*16+(unsigned)hex((unsigned char)json[++i]);if(w<0xdc00||w>0xdfff){free(s);return NULL;}v=0x10000+((v-0xd800)<<10)+(w-0xdc00);}else if(v>=0xdc00&&v<=0xdfff){free(s);return NULL;}if(!v){free(s);return NULL;}if(v<128)s[n++]=(char)v;else if(v<2048){s[n++]=(char)(0xc0|(v>>6));s[n++]=(char)(0x80|(v&63));}else if(v<65536){s[n++]=(char)(0xe0|(v>>12));s[n++]=(char)(0x80|((v>>6)&63));s[n++]=(char)(0x80|(v&63));}else{s[n++]=(char)(0xf0|(v>>18));s[n++]=(char)(0x80|((v>>12)&63));s[n++]=(char)(0x80|((v>>6)&63));s[n++]=(char)(0x80|(v&63));}}
    else{s[n++]=c=='b'?'\b':c=='f'?'\f':c=='n'?'\n':c=='r'?'\r':c=='t'?'\t':(char)c;}}
  s[n]=0;return s;
}
static int equal(int t,const char *s) {char *v=string(t);int ok=v&&!strcmp(v,s);free(v);return ok;}
static int field(int t,const char *s) {if(t<0||tok[t].type!='{')return -1;int found=-1;for(int k=t+1;k<tok[t].next;){int v=k+1;if(equal(k,s)){if(found>=0)return -2;found=v;}k=tok[v].next;}return found;}
static int closed(int t,const char *keys) {if(t<0||tok[t].type!='{')return 0;for(int k=t+1;k<tok[t].next;){char *s=string(k);if(!s)return 0;size_t n=strlen(s);int ok=0;for(const char *p=keys;*p;){const char *e=strchr(p,',');size_t m=e?(size_t)(e-p):strlen(p);if(n==m&&!memcmp(p,s,n))ok=1;p=e?e+1:p+m;}if(field(t,s)!=k+1)ok=0;free(s);if(!ok)return 0;k=tok[k+1].next;}return 1;}
static long number(int t,long max) {if(t<0||tok[t].type!='n')return -1;int n=tok[t].end-tok[t].start;if(n<1||n>16)return -1;char b[20];memcpy(b,json+tok[t].start,(size_t)n);b[n]=0;for(int i=0;i<n;i++)if(b[i]<'0'||b[i]>'9')return -1;char *e;errno=0;long v=strtol(b,&e,10);return errno||*e||v>max?-1:v;}

typedef struct {char *s;size_t n;int bad;size_t cap;} Build;
static void add(Build *b,const char *s) {size_t n=strlen(s);if(b->bad||b->n+n>=b->cap){b->bad=1;return;}memcpy(b->s+b->n,s,n);b->n+=n;b->s[b->n]=0;}
static void quote(Build *b,const char *s) {add(b,"\"");for(const unsigned char *p=(const unsigned char *)s;*p&&!b->bad;p++){char x[8];if(*p=='"'||*p=='\\'){x[0]='\\';x[1]=(char)*p;x[2]=0;}else if(*p<32){int ignored=snprintf(x,sizeof(x),"\\u%04x",*p);(void)ignored;}else{x[0]=(char)*p;x[1]=0;}add(b,x);}add(b,"\"");}
static void integer(Build *b,uint64_t n) {char s[32];int ignored=snprintf(s,sizeof(s),"%llu",(unsigned long long)n);(void)ignored;add(b,s);}
static char outq[FRAME];static size_t outn;static int faulted,stopped,initialized,init_attempted,closing;
static volatile sig_atomic_t interrupted;
static void interrupted_handler(int s) {(void)s;interrupted=1;}
static void emit(Build *b) {if(b->bad||b->n+outn+1>FRAME-32768){faulted=1;stopped=1;return;}memcpy(outq+outn,b->s,b->n);outn+=b->n;outq[outn++]='\n';}
static void flush(void) {if(!outn)return;ssize_t n=write(STDOUT_FILENO,outq,outn);if(n>0){outn-=(size_t)n;memmove(outq,outq+n,outn);}else if(n<0&&errno!=EAGAIN&&errno!=EINTR){closing=1;stopped=1;outn=0;}}
static void reply(long id,const char *s) {char *buf=malloc(FRAME);if(!buf){faulted=1;return;}Build b={buf,0,0,FRAME};add(&b,"{\"id\":");integer(&b,(uint64_t)id);add(&b,",\"result\":");add(&b,s);add(&b,"}");emit(&b);free(buf);}
static void refusal(long id,const char *reason) {char s[160];int ignored=snprintf(s,sizeof(s),"{\"status\":\"unavailable\",\"reason\":\"%s\"}",reason);(void)ignored;reply(id,s);}
static void event(const char *type,const char *v) {char *buf=malloc(FRAME);if(!buf){faulted=1;return;}Build b={buf,0,0,FRAME};add(&b,"{\"type\":");quote(&b,type);add(&b,",\"value\":");add(&b,v);add(&b,"}");emit(&b);free(buf);}

typedef struct {char *path;char hash[65];off_t bytes;int fd;dev_t dev;ino_t ino;} Pin;
typedef struct {char *id,*exe;char hash[65];char *argv[MAX_ARG];int argc;} Entry;
typedef struct {pid_t pid,ppid;uint64_t birth;uid_t uid;dev_t nsdev;ino_t nsino;dev_t nsdevs[4];ino_t nsinos[4];pid_t nspid;int fd,live,fresh;char state;} Proc;
static const char *namespace_files[4]={"pid","mnt","net","user"};
static const char *namespace_names[4]={"pid","mount","network","user"};
typedef struct {int fd,id,pipe_id;struct ucred cred;uint64_t birth;int processfd;size_t bytes;} Peer;
typedef struct {int fd,id;char path[108];dev_t dev;ino_t ino;} Pipe;
static Pin pins[MAX_PIN];static Entry entries[MAX_ENTRY];static int npin,nentry;
static Proc owned[MAX_PROC];static int nowned;static pid_t rootpid;static int root_reaped,root_status,exit_sent;
static int child_in=-1,child_out=-1,child_err=-1;static Peer peers[MAX_PEER];static int next_peer;
static Pipe pipes[2];static int pipe_count;
static char directory[PATH_MAX];static uint64_t output_bytes,ipc_bytes;static int output_limited;
static int read_small(const char *path,char *s,size_t max) {int fd=open(path,O_RDONLY|O_CLOEXEC);if(fd<0)return -1;ssize_t n=read(fd,s,max);close(fd);if(n<0||(size_t)n>=max)return -1;s[n]=0;return (int)n;}
static int process(pid_t pid,Proc *p) {
  char name[80],buf[65536];int ignored=snprintf(name,sizeof(name),"/proc/%d/stat",pid);(void)ignored;if(read_small(name,buf,sizeof(buf)-1)<0)return -1;
  char *q=strrchr(buf,')');if(!q||q[1]!=' ')return -1;q+=2;char *save,*v=strtok_r(q," ",&save);uint64_t birth=0;pid_t pp=0;char state=0;
  for(int fieldno=3;v;fieldno++,v=strtok_r(NULL," ",&save)){if(fieldno==3)state=*v;else if(fieldno==4)pp=(pid_t)strtol(v,NULL,10);else if(fieldno==22){char *end;errno=0;birth=strtoull(v,&end,10);if(errno||*end)return -1;break;}}
  if(!birth){return -1;}ignored=snprintf(name,sizeof(name),"/proc/%d/status",pid);(void)ignored;if(read_small(name,buf,sizeof(buf)-1)<0)return -1;
  char *u=strstr(buf,"\nUid:");if(!u)return -1;unsigned uid;if(sscanf(u,"\nUid:\t%u",&uid)!=1)return -1;
  pid_t ns=pid;char *n=strstr(buf,"\nNSpid:");if(!n)return -1;n+=7;while(*n&&*n!='\n'){while(*n==' '||*n=='\t')n++;if(*n=='\n'||!*n)break;char *end;long id=strtol(n,&end,10);if(end==n||id<=0||id>INT_MAX)return -1;ns=(pid_t)id;n=end;}
  struct stat st[4];
  for(int i=0;i<4;i++){ignored=snprintf(name,sizeof(name),"/proc/%d/ns/%s",pid,namespace_files[i]);(void)ignored;if(stat(name,&st[i]))return -1;}
  *p=(Proc){.pid=pid,.ppid=pp,.birth=birth,.uid=(uid_t)uid,.nsdev=st[0].st_dev,.nsino=st[0].st_ino,.nspid=ns,.fd=-1,.live=1,.fresh=1,.state=state};
  for(int i=0;i<4;i++){p->nsdevs[i]=st[i].st_dev;p->nsinos[i]=st[i].st_ino;}
  return 0;
}
static int same_namespaces(const Proc *a,const Proc *b) {for(int i=0;i<4;i++)if(a->nsdevs[i]!=b->nsdevs[i]||a->nsinos[i]!=b->nsinos[i])return 0;return 1;}
static int held(pid_t pid,uint64_t birth) {for(int i=0;i<nowned;i++)if(owned[i].pid==pid&&owned[i].birth==birth)return i;return -1;}
static int belongs(pid_t pid) {for(int i=0;i<nowned;i++)if(owned[i].pid==pid&&owned[i].live)return 1;return 0;}
static int adopt(Proc *p) {
  int i=held(p->pid,p->birth);if(i>=0){int fd=owned[i].fd;owned[i]=*p;owned[i].fd=fd;return 0;}
  if(nowned>=MAX_PROC){faulted=1;return -1;}int fd=pid_open(p->pid);if(fd<0){if(errno==ESRCH)return 0;faulted=1;return -1;}
  Proc again;if(process(p->pid,&again)||again.birth!=p->birth){close(fd);return 0;}again.fd=fd;owned[nowned++]=again;return 0;
}
/* A whole-host table is used only to discover ancestry; unrelated processes are never signalled. */
static int scan(void) {
  for(int i=0;i<nowned;i++) {
    struct pollfd status={owned[i].fd,POLLIN,0};
    int rc=poll(&status,1,0);
    if(rc>0&&(status.revents&POLLIN)){owned[i].live=0;continue;}
    if(rc<0){faulted=1;continue;}
    Proc p;
    int missing=process(owned[i].pid,&p);
    if(missing||p.birth!=owned[i].birth){
      status.revents=0;
      rc=poll(&status,1,0);
      if(rc>0&&(status.revents&POLLIN))owned[i].live=0;
      else if(rc<0||rc>0||!missing)faulted=1;
      else owned[i].fresh=0;
      /* Namespace files disappear before pidfd death notification during exit.
       * Keep the kernel-held identity signalable, but never report stale namespaces.
       * Final success still requires waitpid(ECHILD), never a missing /proc entry. */
      continue;
    }
    int fd=owned[i].fd;owned[i]=p;owned[i].fd=fd;
  }
  DIR *d=opendir("/proc");if(!d){faulted=1;return -1;}Proc *table=calloc(65536,sizeof(Proc));if(!table){closedir(d);faulted=1;return -1;}int count=0;struct dirent *e;
  while((e=readdir(d))){char *end;long pid=strtol(e->d_name,&end,10);if(*end||pid<=0||pid>INT_MAX)continue;if(count==65536){faulted=1;break;}Proc p;if(!process((pid_t)pid,&p))table[count++]=p;}
  closedir(d);for(int pass=0;pass<MAX_PROC;pass++){int changed=0;for(int i=0;i<count;i++){Proc *p=&table[i];if(p->pid==getpid()||held(p->pid,p->birth)>=0)continue;if(p->ppid==getpid()||belongs(p->ppid)){if(adopt(p)){free(table);return -1;}changed=1;}}if(!changed)break;}
  free(table);return faulted?-1:0;
}
static int reap(void) {int status;pid_t p;for(;;){p=waitpid(-1,&status,WNOHANG);if(p>0){if(p==rootpid){root_reaped=1;root_status=status;}continue;}if(p==0)return 0;if(errno==EINTR)continue;if(errno==ECHILD)return 1;faulted=1;return 0;}}
static int pin_valid(Pin *p) {struct stat f,l;char hash[65];return !fstat(p->fd,&f)&&!lstat(p->path,&l)&&S_ISREG(l.st_mode)&&f.st_dev==l.st_dev&&f.st_ino==l.st_ino&&f.st_dev==p->dev&&f.st_ino==p->ino&&f.st_size==p->bytes&&!hash_fd(p->fd,hash)&&!strcmp(hash,p->hash);}
static int all_pins(void) {for(int i=0;i<npin;i++)if(!pin_valid(&pins[i]))return 0;return 1;}
static int pin_index(const char *path) {for(int i=0;i<npin;i++)if(!strcmp(pins[i].path,path))return i;return -1;}
static int strings(int t,char **a,int max) {if(t<0||tok[t].type!='['||tok[t].size>max)return -1;int n=0;for(int k=t+1;k<tok[t].next;k=tok[k].next){a[n]=string(k);if(!a[n]||strlen(a[n])>4096){free(a[n]);a[n]=NULL;for(int i=0;i<n;i++){free(a[i]);a[i]=NULL;}return -1;}n++;}return n;}
static void free_strings(char **a,int n) {for(int i=0;i<n;i++)free(a[i]);}
static int init_request(int t) {
  if(init_attempted||stopped||!closed(t,"id,op,directory,deadlineMs,runtimePins,selectedEntries"))return 0;
  init_attempted=1;
  char *dir=string(field(t,"directory"));long ms=number(field(t,"deadlineMs"),600000);if(!dir||strlen(dir)>=sizeof(directory)||ms<1){free(dir);return 0;}struct stat ds;char canon[PATH_MAX];
  if(!realpath(dir,canon)||strcmp(dir,canon)||lstat(dir,&ds)||!S_ISDIR(ds.st_mode)||ds.st_uid!=getuid()||(ds.st_mode&0077)){free(dir);return 0;}strcpy(directory,dir);free(dir);
  int a=field(t,"runtimePins");if(a<0||tok[a].type!='['||tok[a].size<1||tok[a].size>MAX_PIN)return 0;
  uint64_t pin_bytes=0;
  for(int k=a+1;k<tok[a].next;k=tok[k].next){if(!closed(k,"path,sha256,byteLength")||tok[k].size!=3)return 0;char *path=string(field(k,"path")),*hash=string(field(k,"sha256"));long len=number(field(k,"byteLength"),268435456);if(!path||!hash||strlen(hash)!=64||len<0){free(path);free(hash);return 0;}for(int h=0;h<64;h++)if(!((hash[h]>='0'&&hash[h]<='9')||(hash[h]>='a'&&hash[h]<='f'))){free(path);free(hash);return 0;}
    pin_bytes+=(uint64_t)len;if(pin_bytes>536870912){free(path);free(hash);return 0;}
    if(path[0]!='/'||!realpath(path,canon)||strcmp(path,canon)||pin_index(path)>=0){free(path);free(hash);return 0;}int fd=open(path,O_RDONLY|O_CLOEXEC|O_NOFOLLOW);struct stat st;if(fd<0||fstat(fd,&st)||!S_ISREG(st.st_mode)){if(fd>=0)close(fd);free(path);free(hash);return 0;}Pin *p=&pins[npin++];*p=(Pin){.path=path,.bytes=(off_t)len,.fd=fd,.dev=st.st_dev,.ino=st.st_ino};memcpy(p->hash,hash,65);free(hash);if(!pin_valid(p))return 0;}
  a=field(t,"selectedEntries");if(a<0||tok[a].type!='['||tok[a].size>MAX_ENTRY)return 0;
  for(int k=a+1;k<tok[a].next;k=tok[k].next){if(!closed(k,"id,executablePath,executableSha256,argv")||tok[k].size!=4)return 0;Entry *e=&entries[nentry++];e->id=string(field(k,"id"));e->exe=string(field(k,"executablePath"));char *hash=string(field(k,"executableSha256"));if(!e->id||strlen(e->id)>128||!e->exe||!hash||strlen(hash)!=64){free(hash);return 0;}memcpy(e->hash,hash,65);free(hash);int pi=pin_index(e->exe);if(pi<0||strcmp(pins[pi].hash,e->hash))return 0;e->argc=strings(field(k,"argv"),e->argv,MAX_ARG);if(e->argc<1||pin_index(e->argv[0])<0)return 0;}
  initialized=1;operation=now_ms()+(uint64_t)ms;return 1;
}

static const char b64[]="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
static void base64(Build *b,const unsigned char *s,size_t n) {add(b,"\"");for(size_t i=0;i<n;i+=3){uint32_t x=(uint32_t)s[i]<<16;if(i+1<n)x|=(uint32_t)s[i+1]<<8;if(i+2<n)x|=s[i+2];char q[5]={b64[(x>>18)&63],b64[(x>>12)&63],i+1<n?b64[(x>>6)&63]:'=',i+2<n?b64[x&63]:'=',0};add(b,q);}add(b,"\"");}
static int decode(const char *s,unsigned char *out,size_t max) {size_t len=strlen(s),n=0;if(len%4)return -1;for(size_t i=0;i<len;i+=4){uint32_t v=0;int pad=0;for(int k=0;k<4;k++){if(s[i+(size_t)k]=='='){if(k<2||i+4!=len)return -1;pad++;v<<=6;}else{if(pad)return -1;const char *p=strchr(b64,s[i+(size_t)k]);if(!p||!s[i+(size_t)k])return -1;v=(v<<6)|(uint32_t)(p-b64);}}if(n+3-(size_t)pad>max)return -1;out[n++]=(unsigned char)(v>>16);if(pad<2)out[n++]=(unsigned char)(v>>8);if(!pad)out[n++]=(unsigned char)v;}return (int)n;}
static void data_event(const char *type,int peer,const unsigned char *s,size_t n) {char buf[CHUNK*2+256];Build b={buf,0,0,sizeof(buf)};add(&b,"{\"type\":");quote(&b,type);add(&b,",\"value\":");if(peer){add(&b,"{\"id\":");integer(&b,(uint64_t)peer);add(&b,",\"data\":");}base64(&b,s,n);if(peer)add(&b,"}");add(&b,"}");emit(&b);}
static void close_peer(Peer *p) {if(p->fd<0)return;char b[32];int ignored=snprintf(b,sizeof(b),"%d",p->id);(void)ignored;event("pipe-end",b);close_fd(&p->fd);close_fd(&p->processfd);}
static void stop_one_pipe(Pipe *p) {
  close_fd(&p->fd);
  for(int i=0;i<MAX_PEER;i++)if(peers[i].pipe_id==p->id)close_peer(&peers[i]);
  if(*p->path){struct stat st;if(!lstat(p->path,&st)&&S_ISSOCK(st.st_mode)&&st.st_dev==p->dev&&st.st_ino==p->ino)unlink(p->path);*p->path=0;}
}
static void stop_pipe(void) {for(int i=0;i<pipe_count;i++)stop_one_pipe(&pipes[i]);}
static void enter_cleanup(void) {stopped=1;if(!cleanup_at){cleanup_at=now_ms();cleanup_end=cleanup_at+10000;}close_fd(&child_in);for(int i=0;i<pipe_count;i++)close_fd(&pipes[i].fd);}
static void signal_owned(int sig) {scan();for(int i=0;i<nowned;i++)if(owned[i].live&&pid_signal(owned[i].fd,sig)&&errno!=ESRCH){faulted=1;}}
static int create_pipe(void) {
  if(pipe_count>=2||!initialized)return 0;
  Pipe *p=&pipes[pipe_count];p->id=pipe_count+1;p->fd=-1;
  int n=snprintf(p->path,sizeof(p->path),"%s/.aihq-%ld-%d.sock",directory,(long)getpid(),p->id);
  if(n<0||(size_t)n>=sizeof(p->path)||strlen(p->path)>100){*p->path=0;return 0;}
  p->fd=socket(AF_UNIX,SOCK_STREAM|SOCK_NONBLOCK|SOCK_CLOEXEC,0);if(p->fd<0)return 0;
  struct sockaddr_un addr;memset(&addr,0,sizeof(addr));addr.sun_family=AF_UNIX;strcpy(addr.sun_path,p->path);
  struct stat st;
  if(bind(p->fd,(struct sockaddr *)&addr,sizeof(addr))){close_fd(&p->fd);*p->path=0;return 0;}
  if(lstat(p->path,&st)){close_fd(&p->fd);*p->path=0;return 0;}
  p->dev=st.st_dev;p->ino=st.st_ino;
  if(chmod(p->path,0600)||listen(p->fd,MAX_PEER)){stop_one_pipe(p);return 0;}
  pipe_count++;return p->id;
}
static void accept_peer(Pipe *pipe) {
  for(;;){int fd=accept4(pipe->fd,NULL,NULL,SOCK_CLOEXEC|SOCK_NONBLOCK);if(fd<0){if(errno!=EAGAIN&&errno!=EINTR)faulted=1;return;}int slot=-1;for(int i=0;i<MAX_PEER;i++)if(peers[i].fd<0){slot=i;break;}if(slot<0){close(fd);faulted=1;return;}Peer *p=&peers[slot];socklen_t size=sizeof(p->cred);if(getsockopt(fd,SOL_SOCKET,SO_PEERCRED,&p->cred,&size)||size!=sizeof(p->cred)||p->cred.uid!=getuid()){close(fd);continue;}
    Proc proc;if(process(p->cred.pid,&proc)){close(fd);continue;}p->processfd=pid_open(p->cred.pid);Proc again;if(p->processfd<0||process(p->cred.pid,&again)||again.birth!=proc.birth){close(fd);close_fd(&p->processfd);continue;}p->fd=fd;p->id=++next_peer;p->pipe_id=pipe->id;p->birth=proc.birth;p->bytes=0;char buf[80];int ignored=snprintf(buf,sizeof(buf),"{\"id\":%d,\"pipeId\":%d}",p->id,pipe->id);(void)ignored;event("connect",buf);
  }
}
static int cmdline(pid_t pid,char *buf,size_t max,char **args,int *argc) {char name[80];int ignored=snprintf(name,sizeof(name),"/proc/%d/cmdline",pid);(void)ignored;int n=read_small(name,buf,max);if(n<1||buf[n-1]!=0)return 0;int k=0;for(int i=0;i<n;){if(k>=MAX_OBS_ARG)return 0;args[k++]=buf+i;i+=(int)strlen(buf+i)+1;}*argc=k;return 1;}
static void namespace_fields(Build *b,const Proc *p) {
  add(b,"{");for(int i=0;i<4;i++){if(i)add(b,",");quote(b,namespace_names[i]);add(b,":\"");integer(b,(uint64_t)p->nsdevs[i]);add(b,":");integer(b,(uint64_t)p->nsinos[i]);add(b,"\"");}add(b,"}");
}
static void identity_fields(Build *b,const Proc *p) {add(b,"\"pid\":");integer(b,(uint64_t)p->pid);add(b,",\"uid\":");integer(b,p->uid);add(b,",\"birth\":\"");integer(b,p->birth);add(b,"\",\"namespace\":\"");integer(b,(uint64_t)p->nsdev);add(b,":");integer(b,(uint64_t)p->nsino);add(b,"\",\"namespacePid\":");integer(b,(uint64_t)p->nspid);add(b,",\"namespaces\":");namespace_fields(b,p);}
static void host_result(long id,const char *status) {
  Proc host,before;if(process(getpid(),&before)||process(getpid(),&host)||host.birth!=before.birth||!same_namespaces(&before,&host)){refusal(id,"platform-unsupported");return;}
  char response[512];Build b={response,0,0,sizeof(response)};
  add(&b,"{\"status\":");quote(&b,status);add(&b,",\"hostNamespaces\":");namespace_fields(&b,&host);add(&b,"}");reply(id,b.s);
}
static int process_image(const Proc *p,char path[PATH_MAX],char hash[65],char *buf,char **args,int *argc) {
  char name[80];int ignored=snprintf(name,sizeof(name),"/proc/%d/exe",p->pid);(void)ignored;ssize_t n=readlink(name,path,PATH_MAX-1);if(n<1||n>=PATH_MAX-1)return 0;path[n]=0;int fd=open(name,O_RDONLY|O_CLOEXEC);if(fd<0)return 0;int ok=!hash_fd(fd,hash);close(fd);return ok&&cmdline(p->pid,buf,65535,args,argc);
}
static void peer_result(long id,int peerid) {
  Peer *p=NULL;for(int i=0;i<MAX_PEER;i++)if(peers[i].fd>=0&&peers[i].id==peerid)p=&peers[i];if(!p){refusal(id,"ipc-peer-unavailable");return;}if(scan()){refusal(id,"ipc-peer-membership");return;}int h=held(p->cred.pid,p->birth);Proc proc;
  if(h<0||!owned[h].live||process(p->cred.pid,&proc)||proc.birth!=p->birth||proc.uid!=p->cred.uid){refusal(id,"ipc-peer-membership");return;}
  struct pollfd pol={p->processfd,POLLIN,0};if(poll(&pol,1,0)!=0){refusal(id,"ipc-peer-birth");return;}
  char image[PATH_MAX],hash[65],buf[65536],*args[MAX_OBS_ARG];int argc;
  if(!all_pins()||!process_image(&proc,image,hash,buf,args,&argc)){refusal(id,"ipc-peer-image");return;}Entry *match=NULL;
  for(int i=0;i<nentry;i++){Entry *e=&entries[i];if(strcmp(e->exe,image)||strcmp(e->hash,hash)||argc!=e->argc+1)continue;int equal_args=1;for(int k=0;k<e->argc;k++)if(strcmp(e->argv[k],args[k+1]))equal_args=0;if(equal_args){if(match){refusal(id,"ipc-peer-entry");return;}match=e;}}
  if(!match){refusal(id,"ipc-peer-entry");return;}Proc after;if(process(proc.pid,&after)||after.birth!=proc.birth||!same_namespaces(&after,&proc)){refusal(id,"ipc-peer-birth");return;}
  char response[65536];Build b={response,0,0,sizeof(response)};add(&b,"{\"status\":\"observed\",");identity_fields(&b,&proc);add(&b,",\"executablePath\":");quote(&b,image);add(&b,",\"executableSha256\":");quote(&b,hash);add(&b,",\"selectedEntryId\":");quote(&b,match->id);add(&b,",\"argv\":[");for(int i=1;i<argc;i++){if(i>1)add(&b,",");quote(&b,args[i]);}add(&b,"]}");if(b.bad)refusal(id,"ipc-peer-command-line");else reply(id,b.s);
}
static int start_request(int t,long id) {
  if(rootpid||!initialized||!closed(t,"id,op,file,argv,cwd,env"))return 0;
  char *file=string(field(t,"file")),*cwd=string(field(t,"cwd")),*args[MAX_ARG+2]={0},*environment[129]={0};int argc=0,nenv=0,ok=0,fdin[2]={-1,-1},fdout[2]={-1,-1},fderr[2]={-1,-1},gate[2]={-1,-1},execerr[2]={-1,-1};
  if(!file||!cwd){goto done;}int pi=pin_index(file);if(pi<0||!all_pins()){refusal(id,"runtime-changed");ok=1;goto done;}
  argc=strings(field(t,"argv"),args+1,MAX_ARG);if(argc<0)goto done;args[0]=file;int e=field(t,"env");if(e<0||tok[e].type!='{'||tok[e].size>128)goto done;
  size_t envbytes=0;for(int k=e+1;k<tok[e].next;k=tok[k+1].next){char *key=string(k),*v=string(k+1);if(!key||!v||field(e,key)!=k+1){free(key);free(v);goto done;}size_t a=strlen(key),b=strlen(v);if(!a||a>128||b>65536){free(key);free(v);goto done;}for(size_t x=0;x<a;x++)if(!((key[x]>='A'&&key[x]<='Z')||(key[x]>='a'&&key[x]<='z')||key[x]=='_'||(x&&key[x]>='0'&&key[x]<='9'))){free(key);free(v);goto done;}envbytes+=a+b+2;if(envbytes>262144){free(key);free(v);goto done;}environment[nenv]=malloc(a+b+2);if(!environment[nenv]){free(key);free(v);goto done;}memcpy(environment[nenv],key,a);environment[nenv][a]='=';memcpy(environment[nenv]+a+1,v,b+1);nenv++;free(key);free(v);}
  if(pipe2(fdin,O_CLOEXEC)||pipe2(fdout,O_CLOEXEC)||pipe2(fderr,O_CLOEXEC)||pipe2(gate,O_CLOEXEC)||pipe2(execerr,O_CLOEXEC|O_NONBLOCK))goto done;
  pid_t parent=getpid(),pid=fork();if(pid<0)goto done;
  if(!pid){close(gate[1]);close(execerr[0]);if(prctl(PR_SET_PDEATHSIG,SIGKILL)||getppid()!=parent)_exit(125);
    char released;ssize_t n=read(gate[0],&released,1);if(n!=1)_exit(125);close(gate[0]);
    if(setsid()<0||chdir(cwd)||dup2(fdin[0],0)<0||dup2(fdout[1],1)<0||dup2(fderr[1],2)<0){int code=errno;ssize_t wrote=write(execerr[1],&code,sizeof(code));(void)wrote;_exit(125);}
    /* CLOEXEC closes facility pins/control/sockets. Explicitly close the pipe copies. */
    close(fdin[0]);close(fdin[1]);close(fdout[0]);close(fdout[1]);close(fderr[0]);close(fderr[1]);
    syscall(SYS_execveat,pins[pi].fd,"",args,environment,AT_EMPTY_PATH);int code=errno;ssize_t wrote=write(execerr[1],&code,sizeof(code));(void)wrote;_exit(125);
  }
  rootpid=pid;Proc proc;if(process(pid,&proc)||adopt(&proc)){close_fd(&gate[1]);enter_cleanup();refusal(id,"session-launch-failed");ok=1;goto done;}
  close(gate[0]);gate[0]=-1;close(execerr[1]);execerr[1]=-1;
  child_in=fdin[1];fdin[1]=-1;child_out=fdout[0];fdout[0]=-1;child_err=fderr[0];fderr[0]=-1;nonblock(child_in);nonblock(child_out);nonblock(child_err);
  char created[128];int ignored=snprintf(created,sizeof(created),"{\"pid\":%d,\"birth\":\"%llu\"}",pid,(unsigned long long)proc.birth);(void)ignored;event("created",created);
  char released=1;if(write(gate[1],&released,1)!=1){enter_cleanup();refusal(id,"session-launch-failed");ok=1;goto done;}close(gate[1]);gate[1]=-1;
  struct pollfd poller={execerr[0],POLLIN,0};int rc=poll(&poller,1,500);int errorcode;ssize_t n=read(execerr[0],&errorcode,sizeof(errorcode));if(rc<=0||n>0){enter_cleanup();char response[160];ignored=snprintf(response,sizeof(response),"{\"status\":\"unavailable\",\"reason\":\"session-launch-failed\",\"partialPid\":%d}",pid);(void)ignored;reply(id,response);}else{char response[160];ignored=snprintf(response,sizeof(response),"{\"status\":\"started\",\"pid\":%d,\"birth\":\"%llu\"}",pid,(unsigned long long)proc.birth);(void)ignored;reply(id,response);}ok=1;
done:
  for(int i=0;i<2;i++){close_fd(&fdin[i]);close_fd(&fdout[i]);close_fd(&fderr[i]);close_fd(&gate[i]);close_fd(&execerr[i]);}if(argc>0)free_strings(args+1,argc);free_strings(environment,nenv);free(file);free(cwd);return ok;
}

static void drain_fd(int *fd,const char *type) {
  unsigned char buf[CHUNK];
  if(*fd<0)return;
  ssize_t n=read(*fd,buf,sizeof(buf));
  if(n>0) {
    if(output_limited)return; /* Discard during bounded cleanup; emit no repeated limit event. */
    output_bytes+=(uint64_t)n;
    if(output_bytes>OUT_LIMIT) {
      char valuebuf[128];
      int ignored=snprintf(valuebuf,sizeof(valuebuf),"{\"reason\":\"output-limit\",\"observedBytes\":%llu}",(unsigned long long)output_bytes);
      (void)ignored;event("fault",valuebuf);output_limited=1;enter_cleanup();return;
    }
    data_event(type,0,buf,(size_t)n);
  } else if(!n||(errno!=EAGAIN&&errno!=EINTR)) {
    close_fd(fd);event(!strcmp(type,"stdout")?"stdout-end":"stderr-end","null");
  }
}
static void io_step(int timeout) {
  struct pollfd fds[MAX_PEER+5];int count=0;fds[count++]=(struct pollfd){STDOUT_FILENO,outn?POLLOUT:0,0};fds[count++]=(struct pollfd){child_out,POLLIN,0};fds[count++]=(struct pollfd){child_err,POLLIN,0};
  for(int i=0;i<2;i++){fds[count++]=(struct pollfd){i<pipe_count?pipes[i].fd:-1,POLLIN,0};}for(int i=0;i<MAX_PEER;i++)fds[count++]=(struct pollfd){peers[i].fd,POLLIN,0};
  int rc=poll(fds,(nfds_t)count,timeout);if(rc<0&&errno!=EINTR){faulted=1;enter_cleanup();}flush();drain_fd(&child_out,"stdout");drain_fd(&child_err,"stderr");for(int i=0;i<pipe_count;i++)if(pipes[i].fd>=0&&(fds[3+i].revents&POLLIN))accept_peer(&pipes[i]);
  for(int i=0;i<MAX_PEER;i++){Peer *p=&peers[i];if(p->fd<0)continue;unsigned char buf[CHUNK];ssize_t n=read(p->fd,buf,sizeof(buf));if(n>0){p->bytes+=(size_t)n;ipc_bytes+=(uint64_t)n;if(ipc_bytes>IPC_LIMIT){event("fault","{\"reason\":\"pipe-limit\"}");enter_cleanup();stop_pipe();}else data_event("pipe-data",p->id,buf,(size_t)n);}else if(!n||(errno!=EAGAIN&&errno!=EINTR))close_peer(p);}
  if(root_reaped&&!exit_sent){char b[128];int ignored=snprintf(b,sizeof(b),"{\"code\":%d,\"signal\":null}",WIFEXITED(root_status)?WEXITSTATUS(root_status):128+WTERMSIG(root_status));(void)ignored;event("exit",b);exit_sent=1;}
}
static int cleanup(unsigned grace,unsigned budget) {
  enter_cleanup();uint64_t end=now_ms()+budget;if(end>cleanup_end)end=cleanup_end;uint64_t gentle=now_ms()+grace;if(gentle>end)gentle=end;signal_owned(SIGTERM);int empty=0;
  do {if(now_ms()>=gentle)signal_owned(SIGKILL);else scan();empty=reap();io_step(5);if(empty)break;}while(now_ms()<end);
  scan();empty=reap();stop_pipe();close_fd(&child_in);if(empty){drain_fd(&child_out,"stdout");drain_fd(&child_err,"stderr");}return empty&&!faulted;
}
static void cleanup_result(long id,int confirmed) {char buf[8192];Build b={buf,0,0,sizeof(buf)};add(&b,"{\"processes\":");quote(&b,confirmed?"confirmed":"unresolved");add(&b,",\"survivors\":[");int count=0,active=0;for(int i=0;i<nowned;i++)if(owned[i].live&&owned[i].state!='Z'){active++;if(count>=32)continue;if(count++)add(&b,",");add(&b,"{\"pid\":");integer(&b,(uint64_t)owned[i].pid);add(&b,",\"role\":");quote(&b,owned[i].pid==rootpid?"client":"helper");add(&b,"}");}add(&b,"],\"activeProcesses\":");integer(&b,(uint64_t)active);add(&b,"}");reply(id,b.s);}
static void inventory(long id) {scan();char *buf=malloc(FRAME);if(!buf){refusal(id,"linux-facility-failed");return;}Build b={buf,0,0,FRAME};add(&b,"{\"status\":\"observed\",\"processes\":[");int count=0,unobserved=0;for(int i=0;i<nowned;i++)if(owned[i].live){if(!owned[i].fresh)unobserved=1;if(count++)add(&b,",");add(&b,"{");identity_fields(&b,&owned[i]);add(&b,"}");}add(&b,"]}");if(faulted||b.bad||unobserved)refusal(id,"termination-unresolved");else reply(id,b.s);free(buf);}
static void inspect(long id,int t) {
  long pid=number(field(t,"pid"),INT_MAX);
  char *birth=string(field(t,"birth"));uint64_t n=0;
  if(birth){char *end;errno=0;n=strtoull(birth,&end,10);if(errno||*end)n=0;}free(birth);
  scan();int h=held((pid_t)pid,n);
  if(faulted||h<0||!owned[h].live||!owned[h].fresh){refusal(id,"ipc-peer-membership");return;}
  Proc before=owned[h],after;char image[PATH_MAX],hash[65],buf[65536],*args[MAX_OBS_ARG];int argc;
  if(!process_image(&before,image,hash,buf,args,&argc)){refusal(id,"ipc-peer-image");return;}
  struct pollfd status={before.fd,POLLIN,0};
  if(poll(&status,1,0)!=0||process(before.pid,&after)||after.birth!=before.birth||!same_namespaces(&after,&before)){refusal(id,"ipc-peer-birth");return;}
  char *response=malloc(FRAME);if(!response){refusal(id,"linux-facility-failed");return;}
  Build b={response,0,0,FRAME};add(&b,"{\"status\":\"observed\",");identity_fields(&b,&before);
  add(&b,",\"executablePath\":");quote(&b,image);add(&b,",\"executableSha256\":");quote(&b,hash);add(&b,",\"argv\":[");
  for(int i=0;i<argc;i++){if(i)add(&b,",");quote(&b,args[i]);}add(&b,"]}");
  if(b.bad)refusal(id,"ipc-peer-command-line");else reply(id,b.s);free(response);
}
static int request_shape(const char *op) {
  const char *keys="id,op";int size=2;
  if(!strcmp(op,"init")){keys="id,op,directory,deadlineMs,runtimePins,selectedEntries";size=6;}
  else if(!strcmp(op,"start")){keys="id,op,file,argv,cwd,env";size=6;}
  else if(!strcmp(op,"terminate")){keys="id,op,graceMs,deadlineMs";size=4;}
  else if(!strcmp(op,"pipe-stop")){keys="id,op,pipeId";size=3;}
  else if(!strcmp(op,"peer")||!strcmp(op,"pipe-close")){keys="id,op,peer";size=3;}
  else if(!strcmp(op,"inspect")){keys="id,op,pid,birth";size=4;}
  else if(!strcmp(op,"input")){keys="id,op,data";size=3;}
  else if(!strcmp(op,"pipe-write")){keys="id,op,peer,data";size=4;}
  return tok[0].size==size&&closed(0,keys);
}
static void request(char *s,int len) {
  json=s;jlen=len;nt=pos=0;if(value(0)!=0){faulted=1;enter_cleanup();return;}space();if(pos!=len||tok[0].type!='{'){faulted=1;enter_cleanup();return;}long id=number(field(0,"id"),INT_MAX);char *op=string(field(0,"op"));if(id<1||!op){free(op);faulted=1;enter_cleanup();return;}
  if(!request_shape(op)){refusal(id,"input-limit");free(op);faulted=1;enter_cleanup();return;}
  if(!strcmp(op,"probe")){if(closed(0,"id,op"))host_result(id,"available");else refusal(id,"input-limit");}
  else if(!strcmp(op,"init")){if(init_request(0))host_result(id,"ready");else {refusal(id,"runtime-changed");enter_cleanup();}}
  else if(!strcmp(op,"cancel")){enter_cleanup();signal_owned(SIGKILL);reply(id,"{\"ok\":true}");}
  else if(!strcmp(op,"terminate")){long grace=number(field(0,"graceMs"),1000),budget=number(field(0,"deadlineMs"),10000);if(grace<0||budget<0||!closed(0,"id,op,graceMs,deadlineMs"))refusal(id,"input-limit");else cleanup_result(id,cleanup((unsigned)grace,(unsigned)budget));}
  else if(!strcmp(op,"pipe-stop")){int which=(int)number(field(0,"pipeId"),2);if(which<1||!closed(0,"id,op,pipeId"))refusal(id,"input-limit");else {for(int i=0;i<pipe_count;i++)if(pipes[i].id==which)stop_one_pipe(&pipes[i]);reply(id,"{\"ok\":true}");}}
  else if(!strcmp(op,"input-end")){close_fd(&child_in);reply(id,"{\"ok\":true}");}
  else if(stopped)refusal(id,"deadline");
  else if(!strcmp(op,"pipe")){int which=closed(0,"id,op")?create_pipe():0;if(which){char response[256];Build b={response,0,0,sizeof(response)};add(&b,"{\"status\":\"ready\",\"pipeId\":");integer(&b,(uint64_t)which);add(&b,",\"endpoint\":");quote(&b,pipes[which-1].path);add(&b,"}");reply(id,b.s);}else refusal(id,"ipc-peer-unavailable");}
  else if(!strcmp(op,"start")){if(!start_request(0,id))refusal(id,"session-launch-failed");}
  else if(!strcmp(op,"peer"))peer_result(id,(int)number(field(0,"peer"),INT_MAX));
  else if(!strcmp(op,"track")||!strcmp(op,"inventory"))inventory(id);
  else if(!strcmp(op,"inspect"))inspect(id,0);
  else if(!strcmp(op,"pipe-close")){int which=(int)number(field(0,"peer"),INT_MAX);for(int i=0;i<MAX_PEER;i++)if(peers[i].id==which)close_peer(&peers[i]);reply(id,"{\"ok\":true}");}
  else if(!strcmp(op,"input")||!strcmp(op,"pipe-write")){char *data=string(field(0,"data"));unsigned char buf[CHUNK];int n=data?decode(data,buf,sizeof(buf)):-1;free(data);int fd=child_in;if(!strcmp(op,"pipe-write")){fd=-1;int which=(int)number(field(0,"peer"),INT_MAX);for(int i=0;i<MAX_PEER;i++)if(peers[i].id==which)fd=peers[i].fd;}if(n<0||fd<0)reply(id,"{\"ok\":false}");else{ssize_t wrote=write(fd,buf,(size_t)n);if(wrote!=n){faulted=1;enter_cleanup();reply(id,"{\"ok\":false}");}else reply(id,"{\"ok\":true}");}}
  else {refusal(id,"input-limit");}free(op);
}
/* Fixed MZ canary syscall. No shell fallback and no path/errno diagnostics.
 * EACCES proves this WSL refusal only with an executable held canary and the
 * independently known interpreter replaced by non-executable /dev/null. */
static int probe_same(const struct stat *a,const struct stat *b) {
  return a->st_dev==b->st_dev&&a->st_ino==b->st_ino&&a->st_size==b->st_size&&a->st_mode==b->st_mode&&a->st_uid==b->st_uid&&
    a->st_mtim.tv_sec==b->st_mtim.tv_sec&&a->st_mtim.tv_nsec==b->st_mtim.tv_nsec&&a->st_ctim.tv_sec==b->st_ctim.tv_sec&&a->st_ctim.tv_nsec==b->st_ctim.tv_nsec;
}
static int probe_report(int denied) {
  const char *message=denied?"exec-denied":"unproven";size_t size=strlen(message);
  ssize_t wrote=write(STDOUT_FILENO,message,size);return wrote==(ssize_t)size&&denied?0:125;
}
static int interop_probe(const char *path) {
  if(getuid()==0||getuid()!=geteuid()||!path||path[0]!='/'||strlen(path)>=PATH_MAX||strstr(path,"//")||strstr(path,"/./")||strstr(path,"/../"))return probe_report(0);
  size_t length=strlen(path);if(length<2||path[length-1]=='/'||!strcmp(path+length-2,"/.")||(length>=3&&!strcmp(path+length-3,"/..")))return probe_report(0);
  for(size_t i=0;i<length;i++){unsigned char c=(unsigned char)path[i];if(!((c>='A'&&c<='Z')||(c>='a'&&c<='z')||(c>='0'&&c<='9')||strchr("/._+-:",c)))return probe_report(0);}
  struct stat before,held,current;if(lstat(path,&before)||!S_ISREG(before.st_mode)||before.st_uid!=getuid()||before.st_nlink!=1||before.st_size<2||before.st_size>1048576||access(path,X_OK))return probe_report(0);
  int fd=open(path,O_RDONLY|O_NOFOLLOW|O_CLOEXEC);if(fd<0)return probe_report(0);unsigned char magic[2];
  int valid=!fstat(fd,&held)&&probe_same(&before,&held)&&pread(fd,magic,2,0)==2&&magic[0]=='M'&&magic[1]=='Z'&&
    !lstat(path,&current)&&probe_same(&held,&current)&&!access(path,X_OK);
  if(!valid||prctl(PR_SET_NO_NEW_PRIVS,1,0,0,0)){close(fd);return probe_report(0);}
  char *args[]={(char *)path,NULL},*environment[]={"LANG=C","LC_ALL=C",NULL};execve(path,args,environment);int failure=errno;
  int unchanged=!fstat(fd,&current)&&probe_same(&held,&current)&&!lstat(path,&before)&&probe_same(&held,&before)&&!access(path,X_OK);close(fd);
  int denied=unchanged&&failure==ENOENT;
  if(unchanged&&failure==EACCES){struct stat interpreter;if(!lstat("/init",&interpreter)&&S_ISCHR(interpreter.st_mode)&&major(interpreter.st_rdev)==1&&minor(interpreter.st_rdev)==3&&!(interpreter.st_mode&0111))denied=1;}
  return probe_report(denied);
}
int main(int argc,char **argv) {
  if(argc==3&&!strcmp(argv[1],"--interop-probe"))return interop_probe(argv[2]);
  if(argc!=1||getuid()==0||getuid()!=geteuid()){return 125;}
  umask(0077);int sub=0;
  if(prctl(PR_SET_NO_NEW_PRIVS,1,0,0,0)||prctl(PR_SET_CHILD_SUBREAPER,1)||prctl(PR_GET_CHILD_SUBREAPER,&sub)||sub!=1){return 125;}int self=pid_open(getpid());if(self<0)return 125;close(self);
  for(int i=0;i<MAX_PEER;i++){peers[i].fd=-1;peers[i].processfd=-1;}signal(SIGPIPE,SIG_IGN);struct sigaction sa;memset(&sa,0,sizeof(sa));sa.sa_handler=interrupted_handler;sigemptyset(&sa.sa_mask);sigaction(SIGTERM,&sa,NULL);sigaction(SIGINT,&sa,NULL);pid_t parent=getppid();if(parent==1||prctl(PR_SET_PDEATHSIG,SIGTERM)||getppid()!=parent)return 125;
  if(nonblock(0)||nonblock(1)){return 125;}operation=now_ms()+30000;event("ready","{\"protocol\":1}");char *input=malloc(FRAME+1);if(!input)return 125;size_t used=0;uint64_t last_scan=0;
  while(!closing||outn){uint64_t now=now_ms();if(interrupted||(now>=operation&&!stopped)){enter_cleanup();signal_owned(SIGKILL);}if(stopped&&!cleanup_at)enter_cleanup();if(stopped&&now>=cleanup_end){cleanup(0,0);outn=0;break;}if(now-last_scan>=25){if(stopped)signal_owned(SIGKILL);else scan();reap();last_scan=now;}io_step(2);
    if(closing){if(!outn)break;continue;}ssize_t n=read(0,input+used,FRAME-used);if(n>0){used+=(size_t)n;for(;;){char *newline=memchr(input,'\n',used);if(!newline)break;size_t len=(size_t)(newline-input);input[len]=0;request(input,(int)len);used-=len+1;memmove(input,newline+1,used);}if(used==FRAME){faulted=1;enter_cleanup();used=0;}}
    else if(!n||(errno!=EAGAIN&&errno!=EINTR)){cleanup(0,cleanup_at?(unsigned)(cleanup_end>now_ms()?cleanup_end-now_ms():0):10000);closing=1;}
  }
  free(input);stop_pipe();for(int i=0;i<nowned;i++)close_fd(&owned[i].fd);for(int i=0;i<npin;i++){close_fd(&pins[i].fd);free(pins[i].path);}for(int i=0;i<nentry;i++){free(entries[i].id);free(entries[i].exe);free_strings(entries[i].argv,entries[i].argc>0?entries[i].argc:0);}close_fd(&child_out);close_fd(&child_err);return faulted?125:0;
}
